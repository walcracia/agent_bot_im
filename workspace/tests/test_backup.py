import hashlib
import io
import sqlite3
import tarfile

import pytest

from tools.backup import backup, restore


def test_live_backup_restore_and_refuse_overwrite(tmp_path):
    source = tmp_path / 'source'
    (source / 'attachments').mkdir(parents=True)
    blob = b'private team file'
    attachment_id = 'abcdef-1234'
    (source / 'attachments' / f'{attachment_id}.bin').write_bytes(blob)
    with sqlite3.connect(source / 'chat.sqlite3') as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE attachments(id TEXT, sha256 TEXT)')
        db.execute('INSERT INTO attachments VALUES (?, ?)', (attachment_id, hashlib.sha256(blob).hexdigest()))
        db.commit()
        archive = tmp_path / 'snapshot.tar.gz'
        backup(source, archive)
    target = tmp_path / 'restored'
    restore(archive, target)
    assert (target / 'attachments' / f'{attachment_id}.bin').read_bytes() == blob
    with pytest.raises(ValueError, match='empty destination'):
        restore(archive, target)
    with pytest.raises(ValueError, match='overwrite'):
        backup(source, archive)


def test_restore_rejects_traversal(tmp_path):
    archive = tmp_path / 'bad.tar.gz'
    with tarfile.open(archive, 'w:gz') as output:
        entry = tarfile.TarInfo('../outside.txt')
        entry.size = 1
        output.addfile(entry, io.BytesIO(b'x'))
    with pytest.raises(ValueError, match='Unsafe'):
        restore(archive, tmp_path / 'target')
    assert not (tmp_path / 'outside.txt').exists()
