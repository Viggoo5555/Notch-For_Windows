'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskbarAPI', {
  ready: () => ipcRenderer.send('taskbar:ready'),
  focus: (pid) => ipcRenderer.send('taskbar:focus', pid),
  launch: (target) => ipcRenderer.send('taskbar:launch', target),
  group: (key) => ipcRenderer.send('taskbar:group', key),
  // A press carries the button itself: its windows and the pin behind it, so
  // main never has to agree with a stale snapshot to open something.
  press: (payload) => ipcRenderer.send('taskbar:press', payload),
  close: (key) => ipcRenderer.send('taskbar:close', key),
  context: (key) => ipcRenderer.send('taskbar:context', { key }),
  reorder: (payload) => ipcRenderer.send('taskbar:reorder', payload),
  start: () => ipcRenderer.send('taskbar:start'),
  system: (kind) => ipcRenderer.send('taskbar:system', kind),
  // A tray button sends its own icon's name as well: the volume, the radio and
  // the backlight are answered by Notch's own panel instead of the shell.
  trayClick: (index, payload) => ipcRenderer.send('taskbar:tray', { index, ...payload }),
  overflow: (payload) => ipcRenderer.send('taskbar:overflow', payload),
  resize: (payload) => ipcRenderer.send('taskbar:size', payload),
  hit: (payload) => ipcRenderer.send('taskbar:hit', payload),
  hoverGroup: (payload) => ipcRenderer.send('taskbar:hover', payload),
  hoverEnd: () => ipcRenderer.send('taskbar:hover-end'),
  onUpdate: (callback) => ipcRenderer.on('taskbar:update', (_event, data) => callback(data)),
  onBackdrop: (callback) => ipcRenderer.on('taskbar:backdrop', (_event, data) => callback(data)),
  // The hover list runs in its own small window above the bar.
  onRows: (callback) => ipcRenderer.on('flyout:rows', (_event, data) => callback(data)),
  onFlyoutBackdrop: (callback) => ipcRenderer.on('flyout:backdrop', (_event, data) => callback(data)),
  flyoutReady: () => ipcRenderer.send('flyout:ready'),
  pick: (hwnd) => ipcRenderer.send('flyout:pick', hwnd),
  // A row of Notch's own notification panel: the shell's icon behind it.
  trayPick: (index, payload) => ipcRenderer.send('flyout:tray', { index, ...payload }),
  // The quick panel's own controls: the sliders and the mute button.
  setQuick: (payload) => ipcRenderer.send('quick:set', payload),
  mute: () => ipcRenderer.send('quick:mute'),
  openQuick: (what) => ipcRenderer.send('quick:open', what),
});
