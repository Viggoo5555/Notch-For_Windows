'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  boot: () => ipcRenderer.invoke('launcher:boot'),
  icons: (targets) => ipcRenderer.invoke('launcher:icons', targets),
  launch: (target) => ipcRenderer.invoke('launcher:launch', target),
  pin: (entry) => ipcRenderer.invoke('launcher:pin', entry),
  hide: () => ipcRenderer.send('launcher:hide'),
  ready: () => ipcRenderer.send('launcher:ready'),
  onShow: (callback) => ipcRenderer.on('launcher:show', () => callback()),
  onBackdrop: (callback) => ipcRenderer.on('launcher:backdrop', (_event, data) => callback(data)),
  onPinned: (callback) => ipcRenderer.on('launcher:pinned', (_event, data) => callback(data)),
});
