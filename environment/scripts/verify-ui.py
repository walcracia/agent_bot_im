"""Real local UI → HTTP/WS → SQLite → second UI test. Uses generated demo credentials only."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import time
import wave
import zlib

import httpx
import imageio_ffmpeg
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'environment/verification'
ASSETS = OUT / 'media'
BASE = 'http://127.0.0.1:18200'


def make_media():
    ASSETS.mkdir(parents=True, exist_ok=True)
    width, height = 480, 240
    raw = b''.join(b'\x00' + b''.join(bytes((49 + x * 50 // width, 117 + y * 40 // height, 97 + x * 30 // width))
                                    if not (35 < x < 435 and 45 < y < 195 and (x // 65 + y // 45) % 3 == 0)
                                    else bytes((224, 237, 215)) for x in range(width)) for y in range(height))
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    (ASSETS / 'design-board.png').write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
    with wave.open(str(ASSETS / 'team-note.wav'), 'wb') as audio:
        audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(900 * math.sin(i * 2 * math.pi * 440 / 16000))) for i in range(16000)))
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
                    'color=c=0x278b70:s=320x180:d=1', '-vf', 'drawgrid=width=80:height=45:thickness=2:color=0xc9e2cc',
                    '-c:v', 'libvpx-vp9', '-an', str(ASSETS / 'project-preview.webm')], check=True, timeout=30)
    (ASSETS / 'meeting-notes.txt').write_text('Team Relay verification: immutable attachment byte roundtrip.\n', encoding='utf-8')
    return [ASSETS / x for x in ['design-board.png', 'team-note.wav', 'project-preview.webm', 'meeting-notes.txt']]


def login(page, account):
    page.goto(BASE)
    page.locator('#server-url').fill(BASE)
    page.locator('#username').fill(account['username'])
    page.locator('#password').fill(account['password'])
    page.locator('#login-submit').click()
    expect(page.locator('#app-view')).to_be_visible()
    expect(page.locator('#connection-text')).to_have_text('已连接到团队', timeout=15000)


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    credentials = json.loads((ROOT / 'environment/config/demo-accounts.json').read_text(encoding='utf-8'))
    accounts = {a['username']: a for a in credentials['accounts']}
    files = make_media()
    errors = []
    run_id = str(int(time.time()))
    results = {'story': 'Two real browser users create a group, exchange text and media, recover a closed websocket, verify persisted bytes.',
               'base_url': BASE, 'checks': [], 'console_errors': errors}
    with httpx.Client(base_url=BASE, timeout=30) as api, sync_playwright() as playwright:
        token = api.post('/api/login', json={k: accounts['admin'][k] for k in ['username', 'password']}).json()['token']
        api.headers['Authorization'] = f'Bearer {token}'
        browser = playwright.chromium.launch(channel='chrome', headless=True)
        admin_context = browser.new_context(viewport={'width': 1440, 'height': 960}, timezone_id='Asia/Shanghai')
        alice_context = browser.new_context(viewport={'width': 1280, 'height': 860}, timezone_id='Asia/Shanghai')
        admin, alice = admin_context.new_page(), alice_context.new_page()
        for page in [admin, alice]:
            page.on('pageerror', lambda error: errors.append(str(error)))
        admin.goto(BASE)
        admin.screenshot(path=str(OUT / 'login.png'))
        login(admin, accounts['admin'])
        login(alice, accounts['alice'])
        admin.locator('#new-chat').click()
        admin.get_by_role('button', name='群聊', exact=True).click()
        title = f'协作验证 · {run_id}'
        admin.locator('#new-conversation-title').fill(title)
        for who in ['alice', 'bob', 'dsh']:
            admin.locator(f'.user-option[data-user-id="{accounts[who]["user"]["id"]}"]').click()
        admin.get_by_role('button', name='创建对话', exact=True).click()
        expect(admin.locator('#chat-title')).to_have_text(title)
        group = alice.locator('#conversation-list button').filter(has_text=title)
        expect(group).to_be_visible(timeout=15000)
        group.click()
        results['checks'].append('Group created through UI; second user received realtime conversation event')
        conversations = api.get('/api/conversations').json()
        cid = next(c['id'] for c in conversations if c['title'] == title)
        text = f'界面到服务器、持久化、再到另一位成员：实时消息已送达。{run_id}'
        admin.locator('#message-input').fill(text)
        admin.locator('#message-input').press('Enter')
        expect(alice.locator('.message-text').filter(has_text=text)).to_be_visible(timeout=15000)
        payload = '<img src=x onerror="document.body.dataset.injected=1">'
        admin.locator('#message-input').fill(payload)
        admin.locator('#send-message').click()
        expect(alice.locator('.message-text').filter(has_text=payload)).to_be_visible()
        assert alice.locator('body').get_attribute('data-injected') is None
        results['checks'].append('Text delivered via WS; untrusted markup rendered literally')
        # Controlled transport closure exercises reconnect and server-history catchup without test-only application hooks.
        alice_context.set_offline(True)
        alice.evaluate('S.socket.close()')
        expect(alice.locator('#connection-text')).to_contain_text('断开')
        missed = f'断线期间的消息，重连后应从历史恢复。{run_id}'
        admin.locator('#message-input').fill(missed)
        admin.locator('#send-message').click()
        alice_context.set_offline(False)
        expect(alice.locator('#connection-text')).to_have_text('已连接到团队', timeout=20000)
        expect(alice.locator('.message-text').filter(has_text=missed)).to_be_visible(timeout=15000)
        assert alice.locator('.message-text').filter(has_text=missed).count() == 1
        results['checks'].append('Offline plus controlled WS closure; reconnect recovered missed message exactly once')
        admin.locator('#file-input').set_input_files([str(p) for p in files])
        for path in files:
            expect(alice.locator('#message-items .file-name, #message-items .media-name').filter(has_text=path.name)).to_be_visible(timeout=30000)
        assert admin.locator('#upload-list .failed').count() == 0
        expect(alice.locator('#message-items img.image-attachment')).to_have_count(1)
        alice.locator('#message-items img.image-attachment').scroll_into_view_if_needed()
        alice.wait_for_function("() => document.querySelector('#message-items img.image-attachment').naturalWidth > 0")
        alice.wait_for_function("() => Array.from(document.querySelectorAll('#message-items audio, #message-items video')).length === 2 && Array.from(document.querySelectorAll('#message-items audio, #message-items video')).every(e => e.readyState >= 1)")
        for selector in ['audio', 'video']:
            alice.locator(f'#message-items {selector}').evaluate('(e) => { e.muted = true; return e.play(); }')
            alice.wait_for_function(f"() => document.querySelector('#message-items {selector}').currentTime > 0")
        results['checks'].append('Four real uploads rendered as image/audio/video/file; image decoded and audio/video played')
        messages = api.get(f'/api/conversations/{cid}/messages').json()
        attachments = [m['attachment'] for m in messages if m['attachment']]
        assert {a['kind'] for a in attachments} == {'image', 'audio', 'video', 'file'}
        for attachment in attachments:
            ticket = api.post(f'/api/attachments/{attachment["id"]}/ticket').json()['url']
            download = api.get(ticket + '&download=1')
            assert download.status_code == 200
            expected = (ASSETS / attachment['name']).read_bytes()
            assert download.content == expected
            assert hashlib.sha256(download.content).hexdigest() == attachment['sha256']
            ranged = api.get(ticket, headers={'Range': 'bytes=0-9'})
            assert ranged.status_code == 206 and ranged.content == expected[:10]
        results['checks'].append('All attachment downloads match source bytes and SHA-256; real HTTP Range returns 206')
        admin.locator('#message-input').fill('文件已同步。把讨论留在这里，让工作继续向前。')
        admin.locator('#send-message').click()
        expect(alice.locator('.message-text').filter(has_text='文件已同步')).to_be_visible()
        admin.screenshot(path=str(OUT / 'chat.png'))
        alice.screenshot(path=str(OUT / 'second-user.png'))
        # The smallest supported Windows content size must retain the complete composer.
        admin.set_viewport_size({'width': 960, 'height': 680})
        expect(admin.locator('#message-input')).to_be_visible()
        expect(admin.locator('#send-message')).to_be_in_viewport()
        admin.screenshot(path=str(OUT / 'compact.png'))
        admin.locator('#nav-logout').click()
        expect(admin.locator('#login-view')).to_be_visible()
        assert admin.locator('#password').input_value() == ''
        results['checks'].append('960×680 composer reachable; logout clears password and returns to login')
        browser.close()
        api.post('/api/logout')
    assert not errors, errors
    results['status'] = 'passed'
    (OUT / 'ui-report.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    run()
