"""Isolated real IM HTTP/SQLite acceptance; synthetic QA and model only."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import importlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time

import httpx
import uvicorn

ROOT = Path(__file__).resolve().parents[2]


@contextmanager
def isolated_server(directory: Path):
    previous = os.environ.get('IM_DATA_DIR')
    os.environ['IM_DATA_DIR'] = str(directory / 'data')
    sys.path.insert(0, str(ROOT / 'workspace'))
    try:
        module = importlib.import_module('server.app')
        if module.app.state.store.data_dir == (directory / 'data').resolve():
            module.app.state.store.conn.close()
        app = module.create_app(directory / 'data')
    finally:
        if previous is None:
            os.environ.pop('IM_DATA_DIR', None)
        else:
            os.environ['IM_DATA_DIR'] = previous
    store = app.state.store
    accounts = {}
    for username, bot in [('admin', False), ('outsider', False), ('dsh', True)]:
        password = secrets.token_urlsafe(24)
        user = store.create_user(username, 'Synthetic ' + username, password, is_admin=username == 'admin', is_bot=bot)
        accounts[username] = {'password': password, 'user': user}
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen(128)
    base = f'http://127.0.0.1:{listener.getsockname()[1]}'
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False, lifespan='on'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
    thread.start()
    try:
        with httpx.Client(base_url=base, timeout=10, trust_env=False) as api:
            for _ in range(100):
                try:
                    if api.get('/api/health').is_success:
                        break
                except httpx.HTTPError:
                    pass
                if not thread.is_alive():
                    raise RuntimeError('Fixture server stopped before readiness')
                time.sleep(0.05)
            else:
                raise RuntimeError('Fixture readiness timed out')
            for name, account in accounts.items():
                response = api.post('/api/login', json={'username': name, 'password': account['password']})
                if not response.is_success:
                    raise RuntimeError('Synthetic login failed')
                account['token'] = response.json()['token']
            api.headers['Authorization'] = 'Bearer ' + accounts['admin']['token']
            chats = {}
            for name, members in [('main', ['admin', 'dsh']), ('other', ['admin', 'outsider'])]:
                response = api.post('/api/conversations', json={'title': 'Synthetic ' + name, 'member_ids': [accounts[key]['user']['id'] for key in members]})
                if not response.is_success:
                    raise RuntimeError('Synthetic conversation creation failed')
                chats[name] = response.json()['id']
        yield base, accounts, chats, store
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        if thread.is_alive():
            server.force_exit = True
            thread.join(timeout=3)
        listener.close()
        if thread.is_alive():
            raise RuntimeError('Owned fixture server failed to stop')


def run(node: Path, output: Path):
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {'status': 'failed', 'scope': 'real isolated IM HTTP/SQLite and StateStore; synthetic QA/worker; zero DSH or real model calls'}
    try:
        with tempfile.TemporaryDirectory(prefix='teamplay-qa-flow-') as temporary:
            directory = Path(temporary)
            with isolated_server(directory) as (base, accounts, chats, store):
                fixture = {'base': base, 'main': chats['main'], 'other': chats['other'], 'statePath': str(directory / 'bridge-state.json'),
                           'accounts': {name: {'token': account['token'], 'user': account['user']} for name, account in accounts.items()}}
                config = directory / 'fixture.json'
                config.write_text(json.dumps(fixture), encoding='utf-8')
                process = subprocess.Popen([str(node), str(ROOT / 'environment/scripts/verify-qa-flow.mjs'), str(config)],
                                           cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                timer = threading.Timer(90, process.kill)
                timer.start()
                received_result = False
                try:
                    for line in process.stdout:
                        message = json.loads(line)
                        if message.get('control') == 'revoke_bot':
                            with store.transaction() as connection:
                                connection.execute('DELETE FROM members WHERE conversation_id=? AND user_id=?', (chats['main'], accounts['dsh']['user']['id']))
                            process.stdin.write('continue\n')
                            process.stdin.flush()
                        elif message.get('type') == 'result':
                            result.update(message['result'])
                            received_result = True
                        else:
                            raise RuntimeError('Unexpected fixture protocol')
                    process.wait(timeout=10)
                    if process.returncode != 0:
                        # Only the synthetic failure is retained; no fixture credentials or raw response bodies.
                        result['runner_failure'] = process.stderr.read().strip()[:1500]
                        raise RuntimeError('Synthetic QA runner failed')
                    if not received_result:
                        raise RuntimeError('Synthetic QA runner omitted its final result')
                    with store.lock:
                        duplicate_count = store.conn.execute('SELECT COUNT(*) FROM (SELECT client_id FROM messages GROUP BY conversation_id,sender_id,client_id HAVING COUNT(*)>1)').fetchone()[0]
                    if duplicate_count:
                        raise RuntimeError('Duplicate synthetic message identity')
                    result['sqliteDuplicateClientIds'] = duplicate_count
                finally:
                    timer.cancel()
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=10)
                    for stream in [process.stdin, process.stdout, process.stderr]:
                        stream.close()
            result['ownedServerStopped'] = True
        result['temporaryDatabaseRemoved'] = not directory.exists()
        result['status'] = 'passed'
    except Exception as cause:
        result['failureType'] = type(cause).__name__
        raise
    finally:
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', type=Path, default=ROOT / 'environment/tools/node-v24.19.0-win-x64/node.exe')
    parser.add_argument('--output', type=Path, default=ROOT / 'environment/verification/qa-flow-v0.4.0/report.json')
    options = parser.parse_args()
    run(options.node, options.output)
