'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CHANNELS = Object.freeze({ unread: 'teamplay:unread', foreground: 'teamplay:foreground', state: 'teamplay:window-state' });

/** Own desktop lifecycle only. Credentials and chat content stay in the renderer. */
function startDesktop(electron, options = {}) {
  const { app, BrowserWindow, session, dialog, Tray, Menu, nativeImage, ipcMain } = electron;
  const assets = options.assets || path.join(__dirname, 'assets');
  const index = options.index || path.join(__dirname, '..', 'client', 'index.html');
  const expectedURL = pathToFileURL(index).href;
  const repeat = options.setInterval || setInterval;
  const cancelRepeat = options.clearInterval || clearInterval;
  let window = null, tray = null, quitting = false, blink = null, unread = 0, alternate = false;
  let normalIcon, unreadIcon;
  const alive = () => window && !window.isDestroyed();
  const foreground = () => !!(alive() && window.isVisible() && !window.isMinimized() && window.isFocused());
  const usableTray = () => tray && !tray.isDestroyed();

  function displayIcon(alert = false) {
    if (usableTray()) tray.setImage(alert ? unreadIcon : normalIcon);
  }
  function stopAttention() {
    if (blink !== null) { cancelRepeat(blink); blink = null; }
    alternate = false;
    if (alive()) window.flashFrame(false);
    displayIcon(unread > 0);
  }
  function notifyForeground() {
    if (foreground()) stopAttention();
    if (alive() && !window.webContents.isDestroyed()) window.webContents.send(CHANNELS.foreground, foreground());
  }
  function attention() {
    if (foreground() || unread === 0) return;
    if (alive()) window.flashFrame(true);
    if (!usableTray() || blink !== null) return;
    alternate = true; displayIcon(true);
    blink = repeat(() => {
      if (foreground() || unread === 0 || !usableTray()) { stopAttention(); return; }
      alternate = !alternate; displayIcon(alternate);
    }, 900);
    blink?.unref?.();
  }
  function showWindow() {
    if (quitting) return;
    if (!alive()) createWindow();
    if (window.isMinimized()) window.restore();
    window.show(); window.focus(); notifyForeground();
  }
  function cleanup() {
    stopAttention();
    if (usableTray()) tray.destroy();
    tray = null;
  }
  function quit() { quitting = true; cleanup(); app.quit(); }
  function createWindow() {
    if (alive()) return;
    window = new BrowserWindow({
      width: 1280, height: 860, minWidth: 960, minHeight: 680,
      title: '同频TeamPlay', backgroundColor: '#171a1d', autoHideMenuBar: true,
      icon: path.join(assets, 'app.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        spellcheck: false, devTools: !app.isPackaged
      }
    });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('did-finish-load', notifyForeground);
    for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) window.on(event, notifyForeground);
    window.on('close', event => {
      if (!quitting && usableTray()) { event.preventDefault(); window.hide(); notifyForeground(); }
      // A failed tray never leaves an inaccessible hidden application.
    });
    window.on('query-session-end', () => { quitting = true; cleanup(); });
    window.on('session-end', () => { quitting = true; cleanup(); });
    window.on('closed', () => { window = null; });
    window.loadFile(index);
  }
  function trusted(event) {
    return !!(alive() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === expectedURL);
  }
  function updateUnread(event, value) {
    if (!trusted(event) || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'count') || !Object.hasOwn(value, 'notify')
      || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 999999 || typeof value.notify !== 'boolean') return;
    unread = value.count;
    if (usableTray()) tray.setToolTip(unread ? `同频TeamPlay · ${unread > 99 ? '99+' : unread} 条未读` : '同频TeamPlay');
    if (unread === 0) stopAttention();
    else { displayIcon(true); if (value.notify) attention(); }
  }

  if (!app.requestSingleInstanceLock()) { app.quit(); return { ready: Promise.resolve(false) }; }
  app.on('before-quit', () => { quitting = true; cleanup(); });
  app.on('will-quit', () => {
    ipcMain.removeListener(CHANNELS.unread, updateUnread);
    ipcMain.removeHandler(CHANNELS.state);
  });
  app.on('second-instance', () => { app.whenReady().then(showWindow); });
  app.on('activate', () => { app.whenReady().then(showWindow); });
  app.on('window-all-closed', () => { if (quitting || !usableTray()) quit(); });
  const ready = app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (_event, item, contents) => {
      if (!alive() || contents.id !== window.webContents.id) { item.cancel(); return; }
      item.setSaveDialogOptions({ title: '保存团队文件', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
      item.once('done', (_e, state) => {
        if (state === 'interrupted') dialog.showErrorBox('下载未完成', '请检查磁盘空间和写入权限，然后重新下载。');
      });
    });
    try {
      normalIcon = nativeImage.createFromPath(path.join(assets, 'tray.png'));
      unreadIcon = nativeImage.createFromPath(path.join(assets, 'tray-unread.png'));
      if (normalIcon.isEmpty() || unreadIcon.isEmpty()) throw new Error('Tray icon is unavailable.');
      tray = new Tray(normalIcon);
      tray.setToolTip('同频TeamPlay');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开同频TeamPlay', click: showWindow },
        { type: 'separator' },
        { label: '退出', click: quit }
      ]));
      tray.on('click', showWindow); tray.on('double-click', showWindow);
    } catch {
      if (usableTray()) tray.destroy();
      tray = null;
    }
    ipcMain.on(CHANNELS.unread, updateUnread);
    ipcMain.handle(CHANNELS.state, event => trusted(event) ? foreground() : false);
    createWindow();
    return true;
  });
  return { ready };
}

module.exports = { startDesktop, CHANNELS };
