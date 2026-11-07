"""Consistent SQLite + immutable attachment snapshots. Backups contain private data."""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import shutil
import sqlite3
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def validate_snapshot(root: Path) -> None:
    with closing(sqlite3.connect(root / 'chat.sqlite3')) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Database integrity check failed')
        for attachment_id, expected in db.execute('SELECT id, sha256 FROM attachments'):
            if not attachment_id or any(c not in '0123456789abcdef-' for c in attachment_id):
                raise ValueError('Invalid attachment identifier')
            path = root / 'attachments' / f'{attachment_id}.bin'
            if not path.is_file() or digest(path) != expected:
                raise ValueError(f'Attachment missing or corrupted: {attachment_id}')


def backup(data_dir: Path, output: Path) -> None:
    data_dir, output = data_dir.resolve(), output.resolve()
    if output.exists():
        raise ValueError('Refusing to overwrite an existing backup')
    if not (data_dir / 'chat.sqlite3').is_file():
        raise ValueError('chat.sqlite3 not found')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='im-backup-') as temporary:
        stage = Path(temporary)
        # Snapshot database first. Referenced immutable files already exist before commit.
        with closing(sqlite3.connect((data_dir / 'chat.sqlite3').as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(stage / 'chat.sqlite3')) as target:
                source.backup(target)
        (stage / 'attachments').mkdir()
        with closing(sqlite3.connect(stage / 'chat.sqlite3')) as db:
            ids = [row[0] for row in db.execute('SELECT id FROM attachments')]
        for attachment_id in ids:
            if not attachment_id or any(c not in '0123456789abcdef-' for c in attachment_id):
                raise ValueError('Invalid attachment identifier')
            filename = f'{attachment_id}.bin'
            shutil.copy2(data_dir / 'attachments' / filename, stage / 'attachments' / filename)
        validate_snapshot(stage)
        manifest = {'format': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                    'files': {str(p.relative_to(stage)).replace('\\', '/'): digest(p)
                              for p in sorted(stage.rglob('*')) if p.is_file()}}
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        partial = output.with_name(output.name + '.partial')
        try:
            with tarfile.open(partial, 'w:gz') as archive:
                for path in sorted(stage.rglob('*')):
                    if path.is_file():
                        archive.add(path, arcname=str(path.relative_to(stage)), recursive=False)
            partial.replace(output)
        finally:
            partial.unlink(missing_ok=True)


def restore(archive_path: Path, data_dir: Path) -> None:
    data_dir = data_dir.resolve()
    if data_dir.exists() and any(data_dir.iterdir()):
        raise ValueError('Restore requires an empty destination; stop server and use a new data directory')
    with tempfile.TemporaryDirectory(prefix='im-restore-') as temporary:
        stage = Path(temporary)
        (stage / 'attachments').mkdir()
        with tarfile.open(archive_path, 'r:gz') as archive:
            seen = set()
            for member in archive.getmembers():
                name = PurePosixPath(member.name)
                if (not member.isfile() or name.is_absolute() or '..' in name.parts
                        or '\\' in member.name or ':' in member.name or member.name in seen):
                    raise ValueError('Unsafe or duplicate archive entry')
                seen.add(member.name)
                target = stage.joinpath(*name.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as destination:
                    shutil.copyfileobj(source, destination)
        manifest = json.loads((stage / 'manifest.json').read_text(encoding='utf-8'))
        if manifest.get('format') != 1:
            raise ValueError('Unknown snapshot format')
        actual = {str(p.relative_to(stage)).replace('\\', '/') for p in stage.rglob('*') if p.is_file()}
        if actual != set(manifest['files']) | {'manifest.json'}:
            raise ValueError('Snapshot manifest does not match archive files')
        for filename, expected in manifest['files'].items():
            name = PurePosixPath(filename)
            if name.is_absolute() or '..' in name.parts or '\\' in filename or ':' in filename:
                raise ValueError('Unsafe manifest entry')
            if digest(stage.joinpath(*name.parts)) != expected:
                raise ValueError('Snapshot checksum mismatch')
        validate_snapshot(stage)
        data_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(stage / 'chat.sqlite3', data_dir / 'chat.sqlite3')
        shutil.copytree(stage / 'attachments', data_dir / 'attachments', dirs_exist_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'restore'])
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    args = parser.parse_args()
    if args.action == 'backup':
        backup(args.data_dir, args.archive)
    else:
        restore(args.archive, args.data_dir)
    print(f'{args.action}: verified successfully')
