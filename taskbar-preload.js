'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskbarAPI', {
  ready: () => ipcRenderer.send('taskbar:ready'),
  focus: (pid) => ipcRenderer.send('taskbar:focus', pid),
  launch: (target) => ipcRenderer.send('taskbar:launch', target),
  group: (key) => ipcRenderer.send('taskbar:group', key),
  context: (key) => ipcRenderer.send('taskbar:context', { key }),
  reorder: (payload) => ipcRenderer.send('taskbar:reorder', payload),
  start: () => ipcRenderer.send('taskbar:start'),
  system: (kind) => ipcRenderer.send('taskbar:system', kind),
  trayClick: (index) => ipcRenderer.send('taskbar:tray', index),
  overflow: () => ipcRenderer.send('taskbar:overflow'),
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
});
