'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const vm = require('node:vm');
const { startDesktop, CHANNELS } = require('../shell.cjs');

async function fixture({ lock = true, failTray = false } = {}) {
  const app = new EventEmitter(); app.isPackaged = true; app.quits = 0;
  app.whenReady = () => Promise.resolve(); app.requestSingleInstanceLock = () => lock;
  app.getPath = () => 'C:/Downloads'; app.quit = () => { app.quits++; app.emit('before-quit'); };
  const windows = [], trays = [], timers = new Set(), session = new EventEmitter(), handlers = new Map();
  session.setPermissionRequestHandler = fn => { session.requestPermission = fn; };
  session.setPermissionCheckHandler = fn => { session.checkPermission = fn; };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = true; this.focused = true; this.minimized = false; this.destroyed = false;
      this.flash = []; this.loads = 0; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: windows.length + 1, mainFrame: { url: '' }, sent: [],
        isDestroyed: () => this.destroyed, setWindowOpenHandler: fn => { this.openHandler = fn; },
        send: (...args) => this.webContents.sent.push(args) });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
    isFocused() { return this.focused; } isMinimized() { return this.minimized; }
    removeMenu() {} flashFrame(value) { this.flash.push(value); }
    loadFile(file) { this.loads++; this.webContents.mainFrame.url = pathToFileURL(file).href; }
    hide() { this.visible = false; this.focused = false; this.emit('hide'); }
    show() { this.visible = true; this.emit('show'); }
    focus() { this.focused = true; this.emit('focus'); }
    minimize() { this.minimized = true; this.focused = false; this.emit('minimize'); }
    restore() { this.minimized = false; this.emit('restore'); }
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', event);
      if (!event.prevented) { this.destroyed = true; this.emit('closed'); app.emit('window-all-closed'); }
      return event;
    }
  }
  class FakeTray extends EventEmitter {
    constructor(icon) { super(); if (failTray) throw new Error('Explorer unavailable'); this.icons = [icon]; this.destroyed = false; trays.push(this); }
    isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
    setImage(icon) { this.icons.push(icon); } setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = (key, fn) => handlers.set(key, fn); ipcMain.removeHandler = key => handlers.delete(key);
  const desktop = startDesktop({ app, BrowserWindow: Window, session: { defaultSession: session }, ipcMain, Tray: FakeTray,
    Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath: file => ({ file, isEmpty: () => false }) },
    dialog: { showErrorBox() {} } }, { setInterval: (fn, milliseconds) => {
      const timer = { fn, milliseconds, unref() {} }; timers.add(timer); return timer;
    }, clearInterval: timer => timers.delete(timer) });
  await desktop.ready;
  const current = () => windows.at(-1);
  const event = () => ({ sender: current().webContents, senderFrame: current().webContents.mainFrame });
  const unread = (count, notify = false, source = event()) => ipcMain.emit(CHANNELS.unread, source, { count, notify });
  return { app, windows, trays, timers, ipcMain, handlers, session, current, event, unread };
}

test('close hides a live window; minimize remains on taskbar; tray and second instance restore without reloading', async () => {
  const f = await fixture(), w = f.current(), tray = f.trays[0];
  assert.equal(w.close().prevented, true); assert.equal(w.destroyed, false); assert.equal(w.visible, false);
  tray.emit('click'); assert.equal(w.visible, true); assert.equal(w.focused, true);
  w.minimize(); assert.equal(w.visible, true); assert.equal(w.minimized, true);
  f.app.emit('second-instance'); await Promise.resolve();
  assert.equal(w.minimized, false); assert.equal(w.focused, true); assert.equal(f.windows.length, 1); assert.equal(w.loads, 1);
  assert.deepEqual(tray.menu.filter(item => item.label).map(item => item.label), ['打开同频TeamPlay', '退出']);
});

test('initial counts do not flash; background new unread flashes tray/taskbar and focus stops attention without clearing unread', async () => {
  const f = await fixture(), w = f.current(), tray = f.trays[0]; w.minimize();
  f.unread(3); assert.equal(f.timers.size, 0); assert.equal(w.flash.includes(true), false);
  f.unread(4, true); f.unread(4, true); assert.equal(f.timers.size, 1); assert.equal(w.flash.at(-1), true);
  const timer = [...f.timers][0]; assert.equal(timer.milliseconds, 900);
  timer.fn(); assert.match(tray.icons.at(-1).file, /tray\.png$/);
  timer.fn(); assert.match(tray.icons.at(-1).file, /tray-unread\.png$/);
  tray.emit('double-click'); assert.equal(f.timers.size, 0); assert.equal(w.flash.at(-1), false);
  assert.match(tray.tooltip, /4 条未读/); assert.match(tray.icons.at(-1).file, /tray-unread\.png$/);
  f.unread(0); assert.equal(tray.tooltip, '同频TeamPlay'); assert.match(tray.icons.at(-1).file, /tray\.png$/);
});

test('foreground messages update badge without starting attention', async () => {
  const f = await fixture(); f.unread(2, true);
  assert.equal(f.timers.size, 0); assert.equal(f.current().flash.includes(true), false);
  assert.match(f.trays[0].tooltip, /2 条未读/);
});

test('IPC rejects foreign windows, subframes, foreign pages and non-bounded payloads', async () => {
  const f = await fixture(), tray = f.trays[0], event = f.event();
  for (const source of [{ ...event, sender: {} }, { ...event, senderFrame: { url: event.senderFrame.url } },
    { ...event, senderFrame: null }]) f.unread(8, true, source);
  const original = event.senderFrame.url; event.senderFrame.url = 'https://example.com'; f.unread(8, true); event.senderFrame.url = original;
  for (const value of [null, [], { count: -1, notify: true }, { count: 1.2, notify: false }, { count: 1000000, notify: false },
    { count: NaN, notify: true }, { count: '3', notify: false }, { count: 3, notify: 1 }, { count: 3, notify: false, token: 'irrelevant' }])
    f.ipcMain.emit(CHANNELS.unread, f.event(), value);
  assert.equal(tray.tooltip, '同频TeamPlay');
  assert.equal(f.handlers.get(CHANNELS.state)({ sender: {} }), false);
  assert.equal(f.handlers.get(CHANNELS.state)(f.event()), true);
  f.unread(7); assert.match(tray.tooltip, /7 条未读/);
});

test('explicit quit and session end release tray/timer and permit real window close', async () => {
  for (const system of [false, true]) {
    const f = await fixture(), w = f.current(); w.minimize(); f.unread(1, true);
    if (system) w.emit('query-session-end'); else f.trays[0].menu.at(-1).click();
    assert.equal(f.timers.size, 0); assert.equal(f.trays[0].destroyed, true);
    assert.equal(w.close().prevented, false); assert.equal(w.destroyed, true);
    f.app.emit('will-quit'); assert.equal(f.handlers.size, 0); assert.equal(f.ipcMain.listenerCount(CHANNELS.unread), 0);
  }
});

test('tray failure retains normal close/quit instead of hiding an inaccessible app', async () => {
  const f = await fixture({ failTray: true }); assert.equal(f.trays.length, 0);
  assert.equal(f.current().close().prevented, false); assert.equal(f.app.quits, 1);
});

test('secondary process exits before creating UI or IPC and desktop security preferences remain enabled', async () => {
  const second = await fixture({ lock: false }); assert.equal(second.windows.length, 0); assert.equal(second.app.quits, 1); assert.equal(second.handlers.size, 0);
  const f = await fixture(), prefs = f.current().options.webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.backgroundThrottling, false); assert.equal(path.basename(prefs.preload), 'preload.cjs');
  assert.equal(f.session.checkPermission(), false); assert.deepEqual(f.current().openHandler(), { action: 'deny' });
  let prevented = false; f.current().webContents.emit('will-navigate', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
});

test('download permission remains restricted to the app window', async () => {
  const f = await fixture(), item = new EventEmitter(); let canceled = false, saved;
  item.cancel = () => { canceled = true; }; item.setSaveDialogOptions = value => { saved = value; }; item.getFilename = () => '../report.txt';
  f.session.emit('will-download', {}, item, { id: -1 }); assert.equal(canceled, true); assert.equal(saved, undefined);
  f.session.emit('will-download', {}, item, f.current().webContents); assert.equal(path.basename(saved.defaultPath), 'report.txt');
});

test('preload exposes only bounded count updates and event callbacks, without leaking IPC events', async () => {
  const ipc = new EventEmitter(), sent = []; ipc.send = (...args) => sent.push(args); ipc.invoke = async () => true;
  let bridge;
  vm.runInNewContext(readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'teamplayDesktop'); bridge = api; } }, ipcRenderer: ipc }; }
  });
  assert.deepEqual(Object.keys(bridge).sort(), ['onWindowState', 'updateUnread']);
  const received = []; const stop = bridge.onWindowState(value => received.push(value));
  await Promise.resolve(); assert.equal(received.at(-1), true);
  const count = received.length; ipc.emit('teamplay:foreground', { secret: 'never exposed' }, false); assert.equal(received.at(-1), false);
  ipc.emit('teamplay:foreground', {}, 'true'); assert.equal(received.length, count + 1);
  stop(); ipc.emit('teamplay:foreground', {}, true); assert.equal(received.length, count + 1);
  for (const value of [-1, NaN, '3', 1.2, 1000000]) bridge.updateUnread(value, true);
  bridge.updateUnread(3, true); assert.equal(sent.length, 1);
  assert.equal(sent[0][0], CHANNELS.unread); assert.equal(JSON.stringify(sent[0][1]), '{"count":3,"notify":true}');
});
