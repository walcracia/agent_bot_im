"""Run the packaged Electron/native Tray fixture against a temporary local IM. No real accounts or model calls."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile

import httpx
import playwright

ROOT = Path(__file__).resolve().parents[2]


def run(output: Path, executable: Path, node: Path):
    output.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location('native_server_fixture', ROOT / 'environment/scripts/verify-ui-v0.1.2.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    with runner.isolated_server() as (base, accounts, _store), tempfile.TemporaryDirectory(prefix='teamplay-native-') as temp:
        with httpx.Client(base_url=base, trust_env=False, timeout=20) as api:
            tokens = {}
            for name in ['admin', 'alice']:
                tokens[name] = runner.response_json(api.post('/api/login', json={key: accounts[name][key] for key in ['username', 'password']}))['token']
            api.headers['Authorization'] = 'Bearer ' + tokens['admin']
            groups = [runner.response_json(api.post('/api/conversations', json={
                'title': title, 'member_ids': [accounts['alice']['user']['id']], 'is_direct': False
            }))['id'] for title in ['桌面合成验收甲', '桌面合成验收乙']]
        profile = Path(temp) / 'profile'
        profile.mkdir()
        package = json.loads((ROOT / 'workspace/package.json').read_text(encoding='utf-8'))
        config = {'base': base, 'accounts': {'admin': {key: accounts['admin'][key] for key in ['username', 'password']}},
                  'tokens': tokens, 'groups': groups, 'exe': str(executable), 'profile': str(profile),
                  'output': str(output), 'version': package['version'],
                  'powershell': shutil.which('pwsh') or str(Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'),
                  'windowProbe': str(ROOT / 'environment/scripts/inspect-native-taskbar.ps1'),
                  'playwright': str(Path(playwright.__file__).parent / 'driver/package/index.mjs')}
        private_config = Path(temp) / 'fixture.json'
        private_config.write_text(json.dumps(config), encoding='utf-8')
        # The child needs only fixture credentials; no model/IM production environment is required.
        result = subprocess.run([str(node), str(ROOT / 'environment/scripts/verify-desktop-native.mjs'), str(private_config)], cwd=ROOT, timeout=180)
        if result.returncode:
            raise RuntimeError(f'Native Electron fixture exited {result.returncode}; inspect the local report')


if __name__ == '__main__':
    version = json.loads((ROOT / 'workspace/package.json').read_text(encoding='utf-8'))['version']
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / f'environment/verification/desktop-native-v{version}')
    parser.add_argument('--exe', type=Path, default=ROOT / f'outputs/desktop-v{version}/TeamRelay-win32-x64/TeamRelay.exe')
    parser.add_argument('--node', type=Path, default=ROOT / 'environment/tools/node-v24.19.0-win-x64/node.exe')
    args = parser.parse_args()
    run(args.output_dir.resolve(), args.exe.resolve(), args.node.resolve(strict=True))
