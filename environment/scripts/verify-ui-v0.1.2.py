"""Real UI acceptance on a temporary local server; no production data or model calls."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
import zlib

import httpx
import imageio_ffmpeg
from playwright.sync_api import expect, sync_playwright
import uvicorn

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / 'environment/verification/ui-v0.1.2'


@contextmanager
def isolated_server():
    """Own the socket, database and server thread until every client has closed."""
    with tempfile.TemporaryDirectory(prefix='team-relay-ui-') as directory:
        previous = os.environ.get('IM_DATA_DIR')
        os.environ['IM_DATA_DIR'] = str(Path(directory) / 'data')
        sys.path.insert(0, str(ROOT / 'workspace'))
        try:
            module = importlib.import_module('server.app')
            # Close only the unused import-time app that belongs to this fixture.
            # Always create our own app so importing this runner never reuses another server's data.
            if module.app.state.store.data_dir == (Path(directory) / 'data').resolve():
                module.app.state.store.conn.close()
            app = module.create_app(Path(directory) / 'data')
        finally:
            if previous is None:
                os.environ.pop('IM_DATA_DIR', None)
            else:
                os.environ['IM_DATA_DIR'] = previous
        store = app.state.store
        accounts = {}
        for username, display_name, admin, bot in [
            ('admin', '演示·小周', True, False), ('alice', '演示·小林', False, False),
            ('bob', '演示·小陈', False, False), ('dsh', '工作助手', False, True),
        ]:
            password = secrets.token_urlsafe(24)
            user = store.create_user(username, display_name, password, is_admin=admin, is_bot=bot)
            accounts[username] = {'username': username, 'password': password, 'user': user}
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(('127.0.0.1', 0))
        listener.listen(128)
        base = f'http://127.0.0.1:{listener.getsockname()[1]}'
        server = uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False, lifespan='on'))
        thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        thread.start()
        try:
            with httpx.Client(base_url=base, timeout=2, trust_env=False) as probe:
                for _ in range(100):
                    if not thread.is_alive():
                        raise RuntimeError('Isolated server exited before becoming ready.')
                    try:
                        if probe.get('/api/health').is_success:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.05)
                else:
                    raise RuntimeError('Isolated server readiness timed out.')
            yield base, accounts, store
        finally:
            server.should_exit = True
            thread.join(timeout=10)
            if thread.is_alive():
                server.force_exit = True
                thread.join(timeout=3)
            listener.close()
            if thread.is_alive():
                raise RuntimeError('Isolated server did not stop; refusing to report success.')


def make_media(directory):
    directory.mkdir(parents=True, exist_ok=True)
    width, height = 320, 160
    raw = b''.join(b'\x00' + bytes((65, 123, 98)) * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    (directory / 'sample-board.png').write_bytes(
        b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
    with wave.open(str(directory / 'sample-note.wav'), 'wb') as audio:
        audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(900 * math.sin(i * 2 * math.pi * 440 / 16000)))
                                   for i in range(16000)))
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
                    'color=c=0x278b70:s=320x180:d=1', '-c:v', 'libvpx-vp9', '-an',
                    str(directory / 'sample-preview.webm')], check=True, timeout=30,
                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    (directory / 'sample-notes.txt').write_text('Synthetic acceptance fixture; immutable byte roundtrip.\n', encoding='utf-8')
    return {kind: directory / filename for kind, filename in [
        ('image', 'sample-board.png'), ('audio', 'sample-note.wav'),
        ('video', 'sample-preview.webm'), ('file', 'sample-notes.txt')]}


def response_json(response):
    # Do not include bodies: they may contain a test session token or random password.
    assert response.is_success, f'Isolated API returned HTTP {response.status_code}'
    return response.json()


def login(page, base, account):
    page.goto(base)
    if page.locator('#server-url').is_visible():
        page.locator('#server-url').fill(base)
    else:
        assert page.locator('#server-url').input_value() == base
    page.locator('#username').fill(account['username'])
    page.locator('#password').fill(account['password'])
    page.locator('#login-submit').click()
    expect(page.locator('#app-view')).to_be_visible()
    expect(page.locator('#connection-dot')).to_have_attribute('aria-label', '已连接', timeout=15000)


def message(page, text):
    return page.locator('#message-items .message').filter(has_text=text)


def send(page, text, recipient=None):
    page.locator('#message-input').fill(text)
    page.locator('#message-input').press('Enter')
    expect(message(page, text)).to_have_count(1)
    if recipient is not None:
        expect(message(recipient, text)).to_have_count(1, timeout=15000)


def run(output, fixture_only=False):
    output.mkdir(parents=True, exist_ok=True)
    results = {'version': '0.1.2', 'status': 'running', 'checks': [], 'screenshots': [],
               'scope': 'Synthetic isolated users, real Chrome/HTTP/WebSocket/SQLite; no real Harness or model.'}
    errors = []
    try:
        with isolated_server() as (base, accounts, store):
            with httpx.Client(base_url=base, timeout=30, trust_env=False) as api:
                token = response_json(api.post('/api/login', json={key: accounts['admin'][key]
                                                                 for key in ['username', 'password']}))['token']
                api.headers['Authorization'] = f'Bearer {token}'
                assert response_json(api.get('/api/health'))['status'] == 'ok'
                results['checks'].append('Temporary data, random accounts and pre-bound local server are usable')
                if not fixture_only:
                    exercise_ui(base, accounts, store, api, output, results, errors)
        # Exiting the context proves lifecycle shutdown and lets TemporaryDirectory remove the database.
        results['checks'].append('Owned server thread stopped and temporary database removed')
        assert not errors, 'Browser raised an uncaught page error; see the local report.'
        results['status'] = 'passed'
    except Exception as error:
        results['status'] = 'failed'
        results['failure_type'] = type(error).__name__
        raise
    finally:
        results['page_errors'] = errors
        (output / 'ui-report.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(results, ensure_ascii=False, indent=2))


def exercise_ui(base, accounts, store, api, output, results, errors):
    files = make_media(output / 'media')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='chrome', headless=True)
        try:
            admin_context = browser.new_context(viewport={'width': 1280, 'height': 860}, timezone_id='Asia/Shanghai')
            alice_context = browser.new_context(viewport={'width': 1280, 'height': 860}, timezone_id='Asia/Shanghai')
            admin, alice = admin_context.new_page(), alice_context.new_page()
            for page in [admin, alice]:
                page.on('pageerror', lambda error: errors.append(str(error)))

            def shot(page, name):
                page.screenshot(path=str(output / name))
                results['screenshots'].append(name)

            admin.goto(base)
            expect(admin.locator('#connection-settings')).to_have_attribute('open', '')
            assert admin.locator('.login-story').count() == 0
            assert '让想法相遇' not in admin.locator('#login-view').inner_text()
            form = admin.locator('#login-form').bounding_box()
            assert abs(form['x'] + form['width'] / 2 - 640) <= 50, 'Login form is not centered'
            for width, height in [(1280, 860), (960, 680), (375, 812)]:
                admin.set_viewport_size({'width': width, 'height': height})
                expect(admin.locator('#login-submit')).to_be_in_viewport()
                assert admin.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Login overflows horizontally'
                shot(admin, f'login-{width}.png')
            admin.set_viewport_size({'width': 1280, 'height': 860})
            admin.locator('#username').fill(accounts['admin']['username'])
            admin.locator('#password').fill('deliberately-incorrect-password')
            admin.locator('#login-submit').click()
            expect(admin.locator('#login-error')).to_be_visible()
            login(admin, base, accounts['admin'])
            login(alice, base, accounts['alice'])
            expect(admin.locator('#details-panel')).to_be_hidden()
            results['checks'].append('Centered login at 1280/960/375; address is editable; wrong password recovers')

            # Exercise real group creation and leave the other user unselected to check unread badges.
            admin.locator('#new-chat').click()
            admin.get_by_role('button', name='群聊', exact=True).click()
            title = '界面验证（演示）'
            admin.locator('#new-conversation-title').fill(title)
            for who in ['alice', 'bob', 'dsh']:
                admin.locator(f'.user-option[data-user-id="{accounts[who]["user"]["id"]}"]').click()
            admin.get_by_role('button', name='开始聊天', exact=True).click()
            expect(admin.locator('#chat-title')).to_have_text(title)
            cid = next(c['id'] for c in response_json(api.get('/api/conversations')) if c['title'] == title)
            alice_row = alice.locator(f'[data-conversation-id="{cid}"]')
            expect(alice_row).to_be_visible(timeout=15000)
            send(admin, '先讨论登录和聊天的使用体验。')
            expect(alice_row.locator('.unread')).to_have_text('1', timeout=15000)
            alice_row.click()
            expect(message(alice, '先讨论登录和聊天的使用体验。')).to_be_visible()
            expect(alice_row.locator('.unread')).to_have_count(0)
            send(admin, '附件和助手入口仍然都在。', alice)
            first, second = message(admin, '先讨论登录和聊天的使用体验。'), message(admin, '附件和助手入口仍然都在。')
            expect(first).to_have_class(re.compile(r'\bgroup-start\b'))
            expect(second).to_have_class(re.compile(r'\bgroup-follow\b'))
            assert admin.locator('#conversation-count').evaluate('(e) => e.getBoundingClientRect().width <= 1.1')
            assert admin.locator('#keyboard-hint').evaluate('(e) => e.getBoundingClientRect().width <= 1.1')
            expect(admin.locator('#message-input')).to_have_attribute('aria-describedby', 'keyboard-hint')
            results['checks'].append('Group UI and real unread badges work; totals/keyboard help no longer occupy visible rows')

            timestamp = second.locator('.message-timestamp summary')
            timestamp.focus()
            timestamp.press('Enter')
            expect(second.locator('.message-timestamp time')).to_be_visible()
            assert second.locator('time').get_attribute('datetime')
            response_json(api.post(f'/api/conversations/{cid}/messages', json={
                'text': '新消息到达时仍应保留时间控件的键盘焦点。', 'client_id': secrets.token_hex(12)}))
            expect(message(admin, '新消息到达时仍应保留时间控件的键盘焦点。')).to_be_visible()
            expect(timestamp).to_be_focused()
            timestamp.press('Enter')
            expect(second.locator('.message-timestamp time')).to_be_hidden()
            results['checks'].append('Consecutive senders group; every timestamp opens by keyboard and keeps focus on new messages')

            box = admin.locator('#message-input')
            short_height = box.bounding_box()['height']
            box.fill('多行输入测试\n' * 6)
            assert box.bounding_box()['height'] > short_height + 20
            box.press('Enter')
            expect(message(alice, '多行输入测试')).to_be_visible()
            assert box.bounding_box()['height'] <= short_height + 2
            before_count = len(response_json(api.get(f'/api/conversations/{cid}/messages')))
            box.fill('中文组合输入不会误发送')
            box.dispatch_event('compositionstart')
            box.press('Enter')
            # Synthetic composition events leave the browser's native textarea newline active.
            # The contract is that composition Enter preserves the text and posts no message.
            assert box.input_value().strip() == '中文组合输入不会误发送'
            assert len(response_json(api.get(f'/api/conversations/{cid}/messages'))) == before_count
            box.dispatch_event('compositionend')
            box.press('Enter')
            expect(message(alice, '中文组合输入不会误发送')).to_be_visible()
            admin.locator('#mention-assistant').click()
            assert box.input_value() == '@dsh '
            box.fill('')
            results['checks'].append('Composer grows and shrinks; Chinese IME Enter is guarded; assistant inserts the real @dsh trigger')

            # Confirm a failed send stays actionable and retries the same message once.
            pattern = f'**/api/conversations/{cid}/messages'
            admin.route(pattern, lambda route: route.abort() if route.request.method == 'POST' else route.continue_())
            send(admin, '网络失败时仍能重试。')
            failed = message(admin, '网络失败时仍能重试。')
            expect(failed.get_by_role('button', name='重试', exact=True)).to_be_visible()
            expect(failed).to_have_class(re.compile(r'\bgroup-start\b'))
            admin.unroute(pattern)
            failed.get_by_role('button', name='重试', exact=True).click()
            expect(message(alice, '网络失败时仍能重试。')).to_have_count(1)
            expect(message(admin, '网络失败时仍能重试。').locator('.message-error')).to_have_count(0)
            results['checks'].append('A failed message remains visible and retryable; retry creates one persisted message')

            for width, height in [(1280, 860), (960, 680)]:
                admin.set_viewport_size({'width': width, 'height': height})
                expect(box).to_be_in_viewport()
                expect(admin.locator('#send-message')).to_be_in_viewport()
                assert admin.evaluate('document.documentElement.scrollWidth <= innerWidth')
                shot(admin, f'chat-{width}.png')
            admin.set_viewport_size({'width': 1280, 'height': 860})
            admin.locator('#nav-members').click()
            expect(admin.locator('#modal h2')).to_have_text('成员')
            shot(admin, 'members-1280.png')
            admin.get_by_role('button', name='关闭', exact=True).click()
            admin.locator('#nav-settings').click()
            shot(admin, 'settings-1280.png')
            admin.get_by_role('button', name='关闭', exact=True).click()
            admin.locator('#attachment-toggle').focus()
            admin.locator('#attachment-toggle').press('Enter')
            expect(admin.locator('#attach-file')).to_be_visible()
            shot(admin, 'attachment-menu-1280.png')
            admin.keyboard.press('Escape')
            expect(admin.locator('#attach-file')).to_be_hidden()
            expect(admin.locator('#attachment-toggle')).to_be_focused()
            admin.locator('#attachment-toggle').click()
            admin.locator('#chat-title').click()
            expect(admin.locator('#attach-file')).to_be_hidden()

            for selector, accepted, paths in [
                ('#attach-file', '', [files['file']]), ('#attach-image', 'image/*', [files['image']]),
                ('#attach-media', 'audio/*,video/*', [files['audio'], files['video']]),
            ]:
                admin.locator('#attachment-toggle').click()
                with admin.expect_file_chooser() as chooser:
                    admin.locator(selector).click()
                assert admin.locator('#file-input').get_attribute('accept') == accepted
                chooser.value.set_files([str(path) for path in paths])
                expect(admin.locator('#attach-file')).to_be_hidden()
                for path in paths:
                    expect(alice.locator('#message-items .file-name, #message-items .media-name').filter(has_text=path.name)).to_be_visible(timeout=30000)
            assert admin.locator('#upload-list .failed').count() == 0
            alice.wait_for_function("() => document.querySelector('img.image-attachment')?.naturalWidth > 0")
            alice.wait_for_function("() => [...document.querySelectorAll('#message-items audio, #message-items video')].length === 2 && [...document.querySelectorAll('#message-items audio, #message-items video')].every(e => e.readyState >= 1)")
            for selector in ['audio', 'video']:
                alice.locator(f'#message-items {selector}').evaluate('(e) => { e.muted = true; return e.play(); }')
                alice.wait_for_function(f"() => document.querySelector('#message-items {selector}').currentTime > 0")
            admin.locator('#chat-area').evaluate('''(area, bytes) => {
                const transfer = new DataTransfer();
                transfer.items.add(new File([new Uint8Array(bytes)], 'sample-dropped.txt', {type:'text/plain'}));
                area.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}));
            }''', list(files['file'].read_bytes()))
            expect(alice.locator('#message-items .file-name').filter(has_text='sample-dropped.txt')).to_be_visible(timeout=30000)
            attachments = [m['attachment'] for m in response_json(api.get(f'/api/conversations/{cid}/messages')) if m['attachment']]
            assert {a['kind'] for a in attachments} == set(files)
            assert len(attachments) == 5
            for attachment in attachments:
                ticket = response_json(api.post(f'/api/attachments/{attachment["id"]}/ticket'))['url']
                download = api.get(ticket + '&download=1')
                expected = files[attachment['kind']].read_bytes()
                assert download.content == expected, attachment['name']
                assert hashlib.sha256(download.content).hexdigest() == attachment['sha256']
                ranged = api.get(ticket, headers={'Range': 'bytes=0-9'})
                assert ranged.status_code == 206 and ranged.content == expected[:10]
            results['checks'].append('Attachment menu keyboard/Escape/outside dismissal and all three choosers work; four real media types and dropped file decode/play and preserve bytes/hash/Range')

            # Regroup persisted server data at sender, five-minute and calendar-day boundaries.
            boundary = response_json(api.post('/api/conversations', json={'title': '分组边界（演示）',
                                          'member_ids': [accounts['alice']['user']['id']], 'is_direct': False}))
            alice_token = response_json(api.post('/api/login', json={key: accounts['alice'][key] for key in ['username', 'password']}))['token']
            start = datetime(2026, 1, 1, 9, tzinfo=timezone.utc)
            rows = []
            for index, (sender, delta) in enumerate([(None, 0), (None, 60), (None, 420), (alice_token, 480), (alice_token, 86400)]):
                headers = {'Authorization': f'Bearer {sender}'} if sender else {}
                row = response_json(api.post(f'/api/conversations/{boundary["id"]}/messages',
                                             json={'text': f'分组边界 {index}', 'client_id': secrets.token_hex(12)}, headers=headers))
                rows.append(row)
                with store.transaction() as connection:
                    connection.execute('UPDATE messages SET created_at=? WHERE id=?', ((start + timedelta(seconds=delta)).isoformat(), row['id']))
            target = admin.locator(f'[data-conversation-id="{boundary["id"]}"]')
            expect(target).to_be_visible(timeout=15000)
            target.click()
            for index, follows in enumerate([False, True, False, False, False]):
                entry = message(admin, f'分组边界 {index}')
                expect(entry).to_have_class(re.compile(r'\bgroup-follow\b' if follows else r'\bgroup-start\b'))
            results['checks'].append('Persisted grouping separates sender changes, gaps over five minutes and calendar days')

            # Existing private chats are reused by the new direct contact action.
            admin.locator('#nav-members').click()
            expect(admin.locator('#modal h2')).to_have_text('成员')
            admin.get_by_role('button', name='与演示·小林聊天', exact=True).click()
            expect(admin.locator('#modal')).not_to_be_visible()
            expect(admin.locator('#chat-title')).to_have_text('演示·小林')
            directs = [c for c in response_json(api.get('/api/conversations')) if c['is_direct']]
            assert len(directs) == 1
            direct_id = directs[0]['id']
            admin.locator('#nav-members').click()
            admin.get_by_role('button', name='与演示·小林聊天', exact=True).click()
            expect(admin.locator('#chat-title')).to_have_text('演示·小林')
            directs = [c for c in response_json(api.get('/api/conversations')) if c['is_direct']]
            assert len(directs) == 1 and directs[0]['id'] == direct_id
            results['checks'].append('Contact chat enters immediately and reuses the existing private conversation')

            admin.locator('#nav-settings').click()
            admin.get_by_role('button', name='添加成员', exact=True).click()
            assert not admin.locator('#new-user-bot').is_checked()
            admin.locator('#new-user-username').fill('assistant_acceptance')
            admin.locator('#new-user-name').fill('演示测试助手')
            admin.locator('#new-user-password').fill(secrets.token_urlsafe(20))
            admin.locator('#new-user-bot').check()
            admin.get_by_role('button', name='创建账号', exact=True).click()
            expect(admin.locator('#modal h2')).to_have_text('成员')
            assert next(u for u in response_json(api.get('/api/users')) if u['username'] == 'assistant_acceptance')['is_bot']
            admin.get_by_role('button', name='关闭', exact=True).click()
            results['checks'].append('Admin can still create an assistant through the real UI; normal-member default stays normal')

            admin.locator(f'[data-conversation-id="{cid}"]').click()
            alice_context.set_offline(True)
            alice.evaluate('S.socket.close()')
            expect(alice.locator('#connection-dot')).to_have_attribute('aria-label', '正在重连')
            missed = '断线期间的消息会在重连后补齐。'
            send(admin, missed)
            alice_context.set_offline(False)
            expect(alice.locator('#connection-dot')).to_have_attribute('aria-label', '已连接', timeout=20000)
            expect(message(alice, missed)).to_have_count(1, timeout=15000)
            payload = '<img src=x onerror="document.body.dataset.injected=1">'
            send(admin, payload, alice)
            assert alice.locator('body').get_attribute('data-injected') is None
            results['checks'].append('Real WebSocket reconnect recovers one copy; hostile markup remains literal text')
            admin.locator('#nav-logout').click()
            expect(admin.locator('#login-view')).to_be_visible()
            assert admin.locator('#password').input_value() == ''
            admin.reload()
            assert not admin.locator('#connection-settings').evaluate('(e) => e.open')
            assert admin.locator('#server-url').input_value() == base
            results['checks'].append('Logout clears password; reload keeps the team address collapsed')
        except Exception:
            if 'admin' in locals() and not admin.is_closed():
                admin.screenshot(path=str(output / 'failure.png'))
                results['failure_screenshot'] = 'failure.png'
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture-only', action='store_true', help='Only check isolated startup/login/shutdown')
    parser.add_argument('--output-dir', type=Path, default=DEFAULT_OUT)
    arguments = parser.parse_args()
    run(arguments.output_dir.resolve(), arguments.fixture_only)
