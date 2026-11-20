"""Desktop unread semantics in real Chrome/HTTP/SQLite with a bounded mock bridge; no production data."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import time

import httpx
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def wait_condition(page, expression, *, arg=None, timeout=15000):
    """Poll through trusted automation evaluation without page-side eval/unsafe-eval."""
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        if page.evaluate(expression, arg=arg):
            return
        page.wait_for_timeout(75)
    raise AssertionError('Condition timed out: ' + expression)


def run(output):
    output.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("tray_ui_fixture", ROOT / 'environment/scripts/verify-ui-v0.1.2.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    report = {'status': 'running', 'scope': 'Real isolated Chrome/HTTP/WebSocket/SQLite; desktop bridge mocked, not native tray acceptance', 'checks': [], 'page_errors': []}
    try:
        with runner.isolated_server() as (base, accounts, _store):
            with httpx.Client(base_url=base, timeout=20, trust_env=False) as api:
                tokens = {}
                for user in ['admin', 'alice']:
                    tokens[user] = runner.response_json(api.post('/api/login', json={key: accounts[user][key] for key in ['username', 'password']}))['token']
                api.headers['Authorization'] = 'Bearer ' + tokens['admin']
                groups = [runner.response_json(api.post('/api/conversations', json={
                    'title': name, 'member_ids': [accounts['alice']['user']['id']], 'is_direct': False
                })) for name in ['托盘验收甲', '托盘验收乙']]

                def send(group, text, user='alice'):
                    return runner.response_json(api.post(f"/api/conversations/{group['id']}/messages",
                        headers={'Authorization': 'Bearer ' + tokens[user]}, json={'text': text, 'client_id': text}))

                def unread(group):
                    return next(item['unread_count'] for item in runner.response_json(api.get('/api/conversations')) if item['id'] == group['id'])

                send(groups[0], 'initial-a'); send(groups[1], 'initial-b')
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(channel='chrome', headless=True)
                    try:
                        context = browser.new_context(viewport={'width': 1280, 'height': 860})
                        page = context.new_page()
                        page.add_init_script("""
                            window.__desktopUpdates = []; let callback;
                            window.teamplayDesktop = {
                                updateUnread(count, notify) { window.__desktopUpdates.push({ count, notify }); },
                                onWindowState(fn) { callback = fn; fn(true); }
                            };
                            window.__desktopForeground = value => callback(value);
                        """)
                        page.on('pageerror', lambda error: report['page_errors'].append(str(error)))
                        runner.login(page, base, accounts['admin'])
                        page.bring_to_front()
                        wait_condition(page, '() => window.__desktopUpdates.length > 0')
                        assert page.evaluate('window.__desktopUpdates.every(item => !item.notify)')
                        assert page.evaluate('window.__desktopUpdates.at(-1).count') == 2
                        report['checks'].append('Initial unread history sets a badge without new-message attention')
                        page.locator(f"[data-conversation-id='{groups[0]['id']}']").click()
                        expect(page.locator('#active-chat')).to_be_visible()
                        wait_condition(page, '() => window.__desktopUpdates.at(-1).count === 1')
                        assert unread(groups[0]) == 0 and unread(groups[1]) == 1

                        # Main-process foreground=false must block markRead even if this browser page itself has focus.
                        page.evaluate('window.__desktopForeground(false)')
                        received = send(groups[0], 'background-a')
                        expect(runner.message(page, 'background-a')).to_have_count(1)
                        wait_condition(page, '() => window.__desktopUpdates.at(-1).count === 2 && window.__desktopUpdates.at(-1).notify')
                        assert unread(groups[0]) == 1
                        alerts = page.evaluate('window.__desktopUpdates.filter(item => item.notify).length')
                        report['checks'].append('Background selected-chat messages remain unread and request attention')

                        page.evaluate('(message) => S.socket.onmessage({data:JSON.stringify({type:"message",message})})', received)
                        wait_condition(page, '(alerts) => window.__desktopUpdates.filter(item => item.notify).length === alerts', arg=alerts)
                        page.evaluate('refreshConversations()')
                        assert page.evaluate('window.__desktopUpdates.filter(item => item.notify).length') == alerts
                        send(groups[0], 'background-own', 'admin')
                        expect(runner.message(page, 'background-own')).to_have_count(1)
                        page.evaluate('refreshConversations()')
                        assert page.evaluate('window.__desktopUpdates.filter(item => item.notify).length') == alerts
                        report['checks'].append('Repeated events, repeated refresh and self messages do not request extra attention')

                        # Close the transport, add a message before reconnect, then let real reconnect supplement history.
                        page.evaluate('S.socket.close()')
                        wait_condition(page, '() => S.socket.readyState === WebSocket.CLOSED')
                        send(groups[0], 'reconnect-a')
                        wait_condition(page, '() => window.__desktopUpdates.at(-1).count === 3', timeout=15000)
                        expect(runner.message(page, 'reconnect-a')).to_have_count(1)
                        assert unread(groups[0]) == 2
                        report['checks'].append('Reconnect catches up missed messages while keeping background unread state')

                        page.evaluate('window.__desktopForeground(true)')
                        wait_condition(page, '() => window.__desktopUpdates.at(-1).count === 1')
                        assert unread(groups[0]) == 0 and unread(groups[1]) == 1
                        report['checks'].append('Foreground restoration marks only the displayed chat read and preserves another chat badge')

                        # A failed read must not visually erase the unread badge or create a successful server read.
                        page.evaluate('window.__desktopForeground(false)')
                        send(groups[0], 'read-failure-a')
                        wait_condition(page, '() => window.__desktopUpdates.at(-1).count === 2')
                        route = f"**/api/conversations/{groups[0]['id']}/read"
                        page.route(route, lambda intercepted: intercepted.abort())
                        page.evaluate('window.__desktopForeground(true)')
                        wait_condition(page, '() => readPending.size === 0')
                        page.evaluate('refreshConversations()')
                        assert unread(groups[0]) == 1 and page.evaluate('window.__desktopUpdates.at(-1).count') == 2
                        page.unroute(route)
                        page.evaluate('returnedToWindow()')
                        wait_condition(page, '() => window.__desktopUpdates.at(-1).count === 1')
                        report['checks'].append('Failed reads retain authoritative unread state and recover on foreground refresh')

                        # Headless Chrome does not reliably move OS focus between pages.
                        # Inject document focus loss while native foreground remains true; actual Windows focus is covered separately.
                        page.evaluate('() => { window.__originalFocus = document.hasFocus; document.hasFocus = () => false; }')
                        send(groups[0], 'blurred-a')
                        expect(runner.message(page, 'blurred-a')).to_have_count(1)
                        wait_condition(page, '() => window.__desktopUpdates.at(-1).count === 2')
                        assert unread(groups[0]) == 1
                        page.evaluate('() => { document.hasFocus = window.__originalFocus; delete window.__originalFocus; return returnedToWindow(); }')
                        wait_condition(page, '() => window.__desktopUpdates.at(-1).count === 1')
                        report['checks'].append('Injected document focus loss blocks reads despite native foreground=true; restoring focus recovers')

                        page.locator('#nav-logout').click()
                        expect(page.locator('#login-view')).to_be_visible()
                        assert page.evaluate('window.__desktopUpdates.at(-1).count === 0 && !window.__desktopUpdates.at(-1).notify')
                        report['checks'].append('Logout clears desktop counts without exposing token or message content')
                        assert not report['page_errors'], report['page_errors']
                    finally:
                        browser.close()
        report['checks'].append('Owned server stopped and temporary data removed')
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'; report['failure_type'] = type(error).__name__; report['failure'] = str(error)
        raise
    finally:
        (output / 'tray-ui-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'environment/verification/desktop-tray-ui')
    run(parser.parse_args().output_dir.resolve())
