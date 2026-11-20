"""Bounded archive extraction for the trusted log worker. No shell and no archive links."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import unicodedata
import zipfile


class Extractor:
    def __init__(self, output, limits):
        self.output = output.resolve(strict=True)
        self.limits = limits
        self.total = 0; self.entries = 0; self.paths = set(); self.files = []
        self.owned = {}; self.archives = []
        root_info = self.output.lstat()
        self.root_identity = (root_info.st_dev, root_info.st_ino)

    @staticmethod
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def owned_regular(self, source):
        # Archive cleanup is only for files created by write(), never original downloads.
        relative = source.relative_to(self.output)
        expected = self.owned.get(relative.as_posix())
        root_info = self.output.lstat()
        if expected is None or not stat.S_ISDIR(root_info.st_mode) or self.output.is_symlink() or self.output.is_junction() \
                or (root_info.st_dev, root_info.st_ino) != self.root_identity:
            raise ValueError('archive cleanup root changed')
        cursor = self.output
        for part in relative.parts[:-1]:
            cursor = cursor / part
            info = cursor.lstat()
            if not stat.S_ISDIR(info.st_mode) or cursor.is_symlink() or cursor.is_junction():
                raise ValueError('archive cleanup parent is not independent')
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode) or source.is_symlink() or source.is_junction() or info.st_nlink != 1 \
                or self.identity(info) != expected or source.resolve(strict=True) != source:
            raise ValueError('archive cleanup file changed')
        return relative.as_posix()

    def discard_archives(self):
        # Validate all owned paths first. Failed/partial extraction is left for diagnosis.
        for source in self.archives:
            self.owned_regular(source)
        for source in self.archives:
            relative = self.owned_regular(source)
            source.unlink()  # Deliberately non-recursive; links and replacements are refused.
            del self.owned[relative]

    def safe_path(self, name):
        name = unicodedata.normalize('NFC', name.replace('\\', '/'))
        if not name or name.startswith('/') or '\0' in name or ':' in name:
            raise ValueError('unsafe archive path')
        parts = PurePosixPath(name).parts
        if any(p in ('..', '.', '') or p.endswith((' ', '.')) or re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', p, re.I) for p in parts):
            raise ValueError('unsafe archive component')
        return '/'.join(parts)

    def write(self, stream, relative, declared=None, compressed=None):
        relative = self.safe_path(relative)
        key = relative.casefold()
        if key in self.paths:
            raise ValueError('duplicate or case-colliding archive path')
        self.paths.add(key); self.entries += 1
        if self.entries > self.limits['maxExtractedFiles']:
            raise ValueError('archive file count exceeded')
        if declared is not None and (declared > self.limits['maxExpandedFileBytes'] or declared + self.total > self.limits['maxExpandedBytes']):
            raise ValueError('declared archive size exceeded')
        if declared and compressed is not None and declared / max(compressed, 1) > self.limits['maxCompressionRatio']:
            raise ValueError('archive compression ratio exceeded')
        destination = self.output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        size = 0; digest = hashlib.sha256()
        with destination.open('xb') as target:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                size += len(chunk); self.total += len(chunk)
                if size > self.limits['maxExpandedFileBytes'] or self.total > self.limits['maxExpandedBytes']:
                    raise ValueError('actual archive size exceeded')
                if compressed is not None and size / max(compressed, 1) > self.limits['maxCompressionRatio']:
                    raise ValueError('actual archive compression ratio exceeded')
                target.write(chunk); digest.update(chunk)
            target.flush()
            created = os.fstat(target.fileno())
        if declared is not None and declared != size:
            raise ValueError('archive declared size mismatch')
        info = destination.lstat()
        if not stat.S_ISREG(info.st_mode) or destination.is_symlink() or info.st_nlink != 1 \
                or (info.st_dev, info.st_ino, info.st_size) != (created.st_dev, created.st_ino, created.st_size):
            raise ValueError('created archive input changed')
        # Windows finalizes last-write timestamps on close; pin them after the
        # closed path has been proved to reference the file handle we created.
        self.owned[relative] = self.identity(info)
        return destination, {'path': relative, 'bytes': size, 'sha256': digest.hexdigest()}

    def expand(self, source, prefix, depth=0):
        if depth > self.limits['maxArchiveDepth']:
            raise ValueError('nested archive depth exceeded')
        lower = source.name.lower()
        archive = zipfile.is_zipfile(source) or tarfile.is_tarfile(source) or lower.endswith('.gz')
        if not archive:
            with source.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            self.files.append({'path': str(source.relative_to(self.output)).replace('\\', '/'), 'bytes': source.stat().st_size,
                               'sha256': digest})
            return
        before = self.total
        if zipfile.is_zipfile(source):
            with zipfile.ZipFile(source) as handle:
                for item in handle.infolist():
                    mode = item.external_attr >> 16
                    self.safe_path(item.filename.rstrip('/'))
                    if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or item.flag_bits & 1:
                        raise ValueError('archive link, special or encrypted member')
                    if item.is_dir():
                        continue
                    with handle.open(item) as stream:
                        child, _ = self.write(stream, prefix + '/' + item.filename, item.file_size, item.compress_size)
                    self.expand(child, prefix + '/' + item.filename + '.contents', depth + 1)
        elif tarfile.is_tarfile(source):
            with tarfile.open(source, 'r:*') as handle:
                for item in handle:
                    self.safe_path(item.name.rstrip('/'))
                    if item.isdir():
                        continue
                    if not item.isfile() or item.islnk() or item.issym():
                        raise ValueError('archive link or special member')
                    with handle.extractfile(item) as stream:
                        child, _ = self.write(stream, prefix + '/' + item.name, item.size)
                    self.expand(child, prefix + '/' + item.name + '.contents', depth + 1)
        else:
            name = source.name[:-3] or 'log.txt'
            with gzip.open(source, 'rb') as stream:
                child, _ = self.write(stream, prefix + '/' + name, compressed=source.stat().st_size)
            self.expand(child, prefix + '/' + name + '.contents', depth + 1)
        if (self.total - before) / max(source.stat().st_size, 1) > self.limits['maxCompressionRatio']:
            raise ValueError('total archive compression ratio exceeded')
        self.archives.append(source)


def extract(inputs, output, limits):
    if output.exists() or output.is_symlink():
        raise ValueError('output must be a new private directory')
    output.mkdir(mode=0o700)
    worker = Extractor(output, limits)
    for index, item in enumerate(inputs):
        source = Path(item['path'])
        if source.is_symlink() or not source.is_file():
            raise ValueError('input is not a regular file')
        # Input names are labels only, never file-system locations.
        name = Path(item['name'].replace('\\', '/')).name
        prefix = f'input-{index + 1:03d}'
        with source.open('rb') as stream:
            child, _ = worker.write(stream, prefix + '/' + name, source.stat().st_size)
        worker.expand(child, prefix + '/contents')
    worker.discard_archives()
    return {'files': worker.files, 'expandedBytes': worker.total, 'entries': worker.entries}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding='utf-8'))
    print(json.dumps(extract(request['inputs'], Path(request['output']), request['limits']), ensure_ascii=True))
