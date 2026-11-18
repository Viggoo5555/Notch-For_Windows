'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  ready: () => ipcRenderer.send('widget:ready'),
  setExpanded: (value) => ipcRenderer.send('widget:expanded', !!value),
  dragStart: () => ipcRenderer.send('widget:drag-start'),
  dragEnd: () => ipcRenderer.send('widget:drag-end'),
  close: () => ipcRenderer.send('widget:close'),
  minimize: () => ipcRenderer.send('widget:minimize'),
  restore: () => ipcRenderer.send('widget:restore'),
  focus: (action) => ipcRenderer.send('focus:action', String(action || 'toggle')),
  copyClip: (id) => ipcRenderer.invoke('notch:copy-clip', id),
  launch: (id) => ipcRenderer.invoke('notch:launch', id),
  onStats: (callback) => ipcRenderer.on('widget:stats', (_event, data) => callback(data)),
  onBackdrop: (callback) => ipcRenderer.on('widget:backdrop', (_event, data) => callback(data)),
  onProcesses: (callback) => ipcRenderer.on('widget:processes', (_event, data) => callback(data)),
  onExpanded: (callback) =>
    ipcRenderer.on('widget:expanded-state', (_event, value) => callback(!!value)),
  onFocus: (callback) => ipcRenderer.on('widget:focus', (_event, data) => callback(data)),
  onClips: (callback) => ipcRenderer.on('widget:clips', (_event, data) => callback(data)),
  onGames: (callback) => ipcRenderer.on('widget:games', (_event, data) => callback(data)),
});
