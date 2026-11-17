'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  ready: () => ipcRenderer.send('widget:ready'),
  setExpanded: (value) => ipcRenderer.send('widget:expanded', !!value),
  dragStart: () => ipcRenderer.send('widget:drag-start'),
  dragEnd: () => ipcRenderer.send('widget:drag-end'),
  close: () => ipcRenderer.send('widget:close'),
  onStats: (callback) => ipcRenderer.on('widget:stats', (_event, data) => callback(data)),
  onBackdrop: (callback) => ipcRenderer.on('widget:backdrop', (_event, data) => callback(data)),
  onProcesses: (callback) => ipcRenderer.on('widget:processes', (_event, data) => callback(data)),
  onExpanded: (callback) =>
    ipcRenderer.on('widget:expanded-state', (_event, value) => callback(!!value)),
});
