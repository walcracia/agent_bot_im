'use strict';
const { app, BrowserWindow, session, dialog } = require('electron');
const path = require('node:path');

app.setName('同频');
// Tests can override the path to keep desktop profiles isolated from real usage.
if (process.env.TEAMRELAY_PROFILE) app.setPath('userData', path.resolve(process.env.TEAMRELAY_PROFILE));
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 960, minHeight: 680,
    title: '同频', backgroundColor: '#f3f7fd', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, '..', 'client', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', (_event, item, webContents) => {
    // Only local renderer initiated downloads are permitted; users choose destination.
    if (!mainWindow || webContents.id !== mainWindow.webContents.id) { item.cancel(); return; }
    item.setSaveDialogOptions({ title: '保存团队文件', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    item.once('done', (_e, state) => { if (state === 'interrupted') dialog.showErrorBox('下载未完成', '请检查磁盘空间和写入权限，然后重新下载。'); });
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
// HTTPS certificate errors retain Electron's default rejection; never bypass TLS.
