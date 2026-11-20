'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Expose two bounded operations, never ipcRenderer, Node, credentials or paths.
let foreground = false;
const listeners = new Set();
function publish(value) {
  if (typeof value !== 'boolean') return;
  foreground = value;
  for (const listener of listeners) { try { listener(value); } catch { /* A UI callback cannot break the bridge. */ } }
}
ipcRenderer.on('teamplay:foreground', (_event, value) => publish(value));
ipcRenderer.invoke('teamplay:window-state').then(publish).catch(() => {});
contextBridge.exposeInMainWorld('teamplayDesktop', Object.freeze({
  updateUnread(count, notify = false) {
    if (Number.isSafeInteger(count) && count >= 0 && count <= 999999 && typeof notify === 'boolean')
      ipcRenderer.send('teamplay:unread', { count, notify });
  },
  onWindowState(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener); listener(foreground);
    return () => listeners.delete(listener);
  }
}));
