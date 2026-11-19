'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  boot: () => ipcRenderer.invoke('launcher:boot'),
  icons: (targets) => ipcRenderer.invoke('launcher:icons', targets),
  launch: (target) => ipcRenderer.invoke('launcher:launch', target),
  pin: (entry) => ipcRenderer.invoke('launcher:pin', entry),
  hide: () => ipcRenderer.send('launcher:hide'),
  ready: () => ipcRenderer.send('launcher:ready'),
  // Sent once the dismissal has painted, so the window only goes away with a
  // transparent frame on screen and the next show cannot flash the old one.
  hidden: () => ipcRenderer.send('launcher:hidden'),
  onShow: (callback) => ipcRenderer.on('launcher:show', () => callback()),
  onDismiss: (callback) => ipcRenderer.on('launcher:dismiss', () => callback()),
  onBackdrop: (callback) => ipcRenderer.on('launcher:backdrop', (_event, data) => callback(data)),
  onPinned: (callback) => ipcRenderer.on('launcher:pinned', (_event, data) => callback(data)),
});
