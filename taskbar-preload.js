'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskbarAPI', {
  ready: () => ipcRenderer.send('taskbar:ready'),
  focus: (pid) => ipcRenderer.send('taskbar:focus', pid),
  launch: (target) => ipcRenderer.send('taskbar:launch', target),
  onUpdate: (callback) => ipcRenderer.on('taskbar:update', (_event, data) => callback(data)),
  onBackdrop: (callback) => ipcRenderer.on('taskbar:backdrop', (_event, data) => callback(data)),
});
