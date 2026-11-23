"""Validate full portable ZIP CRC, file manifest and every file hash without starting the app."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parents[2]
version = json.loads((ROOT / 'workspace/package.json').read_text(encoding='utf-8'))['version']
assert re.fullmatch(r'\d+\.\d+\.\d+(?:-[\w.-]+)?', version)
outputs = ROOT / 'outputs'
build = outputs / ('desktop-v' + version)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive', type=Path, default=outputs / 'TeamRelay-portable.zip')
parser.add_argument('--checksum', type=Path)
args = parser.parse_args()
archive = args.archive.resolve(strict=True)
expected = {p.relative_to(build).as_posix(): p for p in build.rglob('*') if p.is_file()}
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None, 'ZIP CRC failed'
    names = [item.filename for item in bundle.infolist() if not item.is_dir()]
    assert len(names) == len(set(names)) == 74, 'Unexpected Electron 45.2.3 portable manifest'
    assert set(names) == set(expected), 'ZIP file list differs from built directory'
    for name in names:
        with bundle.open(name) as packed, expected[name].open('rb') as unpacked:
            assert hashlib.file_digest(packed, 'sha256').digest() == hashlib.file_digest(unpacked, 'sha256').digest(), name
    assert bundle.read('WINDOWS-README.txt').decode('utf-8').startswith('同频TeamPlay')
with archive.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
checksum = args.checksum or (outputs / f'SHA256SUMS-v{version}-portable.txt')
if not checksum.exists() and args.checksum is None:
    checksum = outputs / 'SHA256SUMS-portable.txt'
checksum_lines = [line.split(maxsplit=1) for line in checksum.read_text(encoding='utf-8').splitlines() if line.strip()]
assert [digest, archive.name] in checksum_lines, 'Archive hash/name missing from checksum manifest'
report = {'status': 'passed', 'version': version, 'files': len(names), 'bytes': archive.stat().st_size,
          'sha256': digest, 'crc': 'passed', 'every_file_hash': 'matched'}
output = ROOT / 'environment/verification' / ('desktop-artifacts-v' + version)
output.mkdir(parents=True, exist_ok=True)
(output / 'zip-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
