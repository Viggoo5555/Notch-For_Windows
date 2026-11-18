'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceHud', {
  onState: (callback) => ipcRenderer.on('voicehud:state', (_event, payload) => callback(payload)),
  onLevel: (callback) => ipcRenderer.on('voicehud:level', (_event, value) => callback(value)),
});
