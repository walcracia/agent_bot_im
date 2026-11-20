/** Real packaged Electron/Tray/IPC + isolated IM. Native events are driven by Playwright, not manual OS clicks. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { _electron } = await import(pathToFileURL(config.playwright).href);
const report = { status: 'running', scope: 'Real packaged Windows Electron, native Tray/window APIs and IPC; temporary real IM; synthetic accounts. Programmatic native events, not manual tray clicks.', checks: [], screenshots: [], errors: [] };
let application;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA)$/i.test(key)));
environment.TEAMRELAY_PROFILE = config.profile;
async function waitFor(test, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out: ' + label);
}
async function request(path, token, value) {
  const response = await fetch(config.base + path, { method: value === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(15000) });
  assert.equal(response.ok, true, 'IM request failed: ' + path);
  return response.json();
}
const counts = async () => Object.fromEntries((await request('/api/conversations', config.tokens.admin)).map(c => [c.id, c.unread_count]));
const send = (group, key) => request(`/api/conversations/${group}/messages`, config.tokens.alice, { text: key, client_id: key });
const native = async () => application.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0], p = globalThis.__trayProbe;
  return { windows: BrowserWindow.getAllWindows().length, visible: w.isVisible(), minimized: w.isMinimized(),
    focused: w.isFocused(), tray: !!p?.tray && !p.tray.isDestroyed(), images: p?.images ?? [], flashes: p?.flashes ?? [] };
});
try {
  application = await _electron.launch({ executablePath: config.exe, args: [], env: environment, timeout: 30000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.waitForSelector('#login-form');
  assert.equal(await page.title(), '同频TeamPlay');
  const metadata = await application.evaluate(({ app, BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { version: app.getVersion(), profile: app.getPath('userData'), sandbox: preferences.sandbox,
      isolated: preferences.contextIsolation, node: preferences.nodeIntegration };
  });
  assert.equal(metadata.version, config.version); assert.equal(metadata.profile.toLowerCase(), config.profile.toLowerCase());
  assert.equal(metadata.sandbox, true); assert.equal(metadata.isolated, true); assert.equal(metadata.node, false);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.teamplayDesktop).sort()), ['onWindowState', 'updateUnread']);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  report.checks.push('Packaged version, isolated profile and sandboxed bounded preload verified');
  for (const [width, height] of [[1280, 860], [960, 680]]) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await page.screenshot({ path: join(config.output, `login-${width}.png`) }); report.screenshots.push(`login-${width}.png`);
  }
  // Observe real native calls while forwarding each original call unchanged.
  await application.evaluate(({ Tray, BrowserWindow }) => {
    const p = globalThis.__trayProbe = { tray: null, images: [], flashes: [] };
    const tooltip = Tray.prototype.setToolTip, image = Tray.prototype.setImage;
    Tray.prototype.setToolTip = function(value) { p.tray = this; return tooltip.call(this, value); };
    Tray.prototype.setImage = function(value) { p.tray = this; p.images.push(value.toPNG().toString('base64')); return image.call(this, value); };
    const w = BrowserWindow.getAllWindows()[0], flash = w.flashFrame;
    w.flashFrame = function(value) { p.flashes.push(value); return flash.call(this, value); };
  });
  if (!(await page.locator('#server-url').isVisible())) await page.locator('#connection-settings summary').click();
  await page.locator('#server-url').fill(config.base);
  await page.locator('#username').fill(config.accounts.admin.username);
  await page.locator('#password').fill(config.accounts.admin.password);
  await page.locator('#login-submit').click(); await page.waitForSelector('#app-view:not([hidden])');
  await waitFor(async () => (await native()).tray, 'real native Tray captured after preload IPC');
  await page.locator(`[data-conversation-id="${config.groups[0]}"]`).click();
  await page.waitForSelector('#active-chat:not([hidden])');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitFor(async () => !(await native()).visible, 'close hides window');
  assert.equal((await native()).windows, 1); assert.equal((await native()).tray, true);
  const hiddenMessage = await send(config.groups[0], 'native-hidden-message');
  await page.waitForSelector(`[data-message-id="${hiddenMessage.id}"]`);
  await waitFor(async () => (await counts())[config.groups[0]] === 1, 'hidden selected chat remains unread');
  await waitFor(async () => { const s = await native(); return s.flashes.includes(true) && new Set(s.images).size >= 2 && s.images.length >= 3; }, 'real Tray alternation and native flash call');
  report.checks.push('Close hides without quitting; real WebSocket message remains unread; native Tray images alternate and flashFrame(true) called');
  await application.evaluate(() => globalThis.__trayProbe.tray.emit('click'));
  await page.bringToFront();
  await waitFor(async () => { const s = await native(); return s.visible && s.focused; }, 'native tray click event restores foreground');
  await waitFor(async () => (await counts())[config.groups[0]] === 0, 'restored chat read');
  assert.equal((await native()).flashes.at(-1), false);
  report.checks.push('Real Tray click handler restores window and clears attention; foreground IPC/read acknowledgment reaches server');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await waitFor(async () => (await native()).minimized, 'native minimized state');
  const handle = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
  const rawWindow = JSON.parse((await promisify(execFile)(config.powershell,
    ['-NoProfile', '-File', config.windowProbe, '-WindowHandle', handle], { windowsHide: true, timeout: 15000 })).stdout);
  assert.equal(rawWindow.minimized, true); assert.equal(rawWindow.windowStyleVisible, true);
  assert.equal(rawWindow.toolWindow, false); assert.equal(rawWindow.owned, false);
  report.taskbarWindowStyles = rawWindow;
  await send(config.groups[1], 'native-other-chat-message');
  await waitFor(async () => (await counts())[config.groups[1]] === 1 && (await native()).flashes.at(-1) === true, 'minimized taskbar attention');
  await application.evaluate(() => globalThis.__trayProbe.tray.emit('double-click'));
  await page.bringToFront(); await waitFor(async () => !(await native()).minimized && (await native()).focused, 'double click restore');
  assert.equal((await counts())[config.groups[1]], 1);
  report.checks.push('Minimize retains taskbar; another chat triggers native attention; restoring selected chat preserves other unread');
  for (const [width, height] of [[1280, 860], [960, 680]]) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await page.screenshot({ path: join(config.output, `chat-${width}.png`) }); report.screenshots.push(`chat-${width}.png`);
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await promisify(execFile)(config.exe, [], { env: environment, windowsHide: true, timeout: 15000 });
  await waitFor(async () => !(await native()).minimized, 'second instance restores existing window');
  assert.equal((await native()).windows, 1);
  report.checks.push('A second packaged process with the same profile exits and restores the single original window');
  await page.bringToFront(); await page.locator('#nav-logout').click();
  await page.waitForSelector('#login-view:not([hidden])');
  assert.equal((await native()).flashes.at(-1), false); assert.equal(report.errors.length, 0);
  report.checks.push('Logout clears native attention; no renderer page errors');
  await application.close(); application = null;
  report.checks.push('Explicit application quit terminates the owned fixture instead of hiding it');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = String(error); throw error; }
finally {
  if (application) await application.close().catch(() => {});
  await writeFile(join(config.output, 'native-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, failure: report.failure }));
}
