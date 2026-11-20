"""Install the pinned public parser into project-local ignored tools; never changes DSH."""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tempfile
import urllib.request
import zipfile

URL = 'https://list.notmmao.com/ota-log-triage/ota-log-triage-1.3.2.zip'
SHA256 = '3be41e8de6d60ace8f22c99469854023bc8ed4622d212998eea2be9b5f057e17'
FILES_DIGEST = '02bfa88c2871a8f748f4a52647075c505ccb7e5fe88765ada5a839aca4319ad5'
ROOT = Path(__file__).resolve().parents[2]


def install(destination):
    destination = destination.absolute()
    tools = (ROOT / 'environment/tools').resolve()
    if not destination.resolve().is_relative_to(tools) or destination.resolve() == tools:
        raise ValueError('Destination must be a dedicated directory under project environment/tools')
    if destination.exists():
        raise FileExistsError('Destination exists; verify or choose a new tools directory instead of overwriting')
    with urllib.request.urlopen(URL, timeout=30) as response:
        payload = response.read(144548)
    if len(payload) != 144547 or hashlib.sha256(payload).hexdigest() != SHA256:
        raise ValueError('Pinned skill archive size or SHA256 mismatch')
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        files = {}
        contents = {}
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = info.filename
            parts = PurePosixPath(name).parts
            if '\\' in name or ':' in name or not parts or parts[0] != 'ota-log-triage' or any(p in ('.', '..') for p in parts):
                raise ValueError('Unexpected skill entry path')
            if stat.S_ISLNK(info.external_attr >> 16) or info.file_size > 2000000:
                raise ValueError('Unexpected skill entry type or size')
            relative = '/'.join(parts[1:])
            if not relative or relative in files:
                raise ValueError('Duplicate skill entry')
            value = archive.read(info)
            files[relative] = hashlib.sha256(value).hexdigest(); contents[relative] = value
        canonical = json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        if len(files) != 24 or hashlib.sha256(canonical).hexdigest() != FILES_DIGEST:
            raise ValueError('Unexpected pinned file manifest')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='triage-install-', dir=destination.parent) as temporary:
        stage = Path(temporary) / 'skill'; stage.mkdir(mode=0o700)
        for name, content in contents.items():
            output = stage / name
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open('xb') as stream:
                stream.write(content)
        # The public archive has CommonJS scripts but no module boundary.
        (stage / 'package.json').write_text('{"type":"commonjs"}\n', encoding='utf-8')
        (stage / 'integrity.json').write_text(json.dumps({'version': '1.3.2', 'archiveSha256': SHA256, 'files': files}, ensure_ascii=False, indent=2), encoding='utf-8')
        os.rename(stage, destination)
    return {'status': 'installed', 'version': '1.3.2', 'files': len(files), 'archiveSha256': SHA256, 'directory': str(destination)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=ROOT / 'environment/tools/ota-log-triage-1.3.2')
    print(json.dumps(install(parser.parse_args().destination), ensure_ascii=False))
