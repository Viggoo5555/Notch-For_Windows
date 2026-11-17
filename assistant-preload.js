'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  boot: () => ipcRenderer.invoke('assistant:boot'),
  status: () => ipcRenderer.invoke('assistant:status'),
  startEngine: () => ipcRenderer.invoke('assistant:start'),
  chat: (payload) => ipcRenderer.invoke('assistant:chat', payload),
  stop: () => ipcRenderer.send('assistant:stop'),
  pull: (name) => ipcRenderer.invoke('assistant:pull', name),
  remove: (name) => ipcRenderer.invoke('assistant:remove', name),
  voices: () => ipcRenderer.invoke('assistant:voices'),
  speak: (text) => ipcRenderer.invoke('assistant:speak', text),
  hush: () => ipcRenderer.send('assistant:hush'),
  save: (patch) => ipcRenderer.invoke('assistant:settings', patch),
  open: (url) => ipcRenderer.invoke('assistant:open', url),
  hide: () => ipcRenderer.send('assistant:hide'),
  onDelta: (callback) => ipcRenderer.on('assistant:delta', (_event, text) => callback(text)),
  onDone: (callback) => ipcRenderer.on('assistant:done', (_event, payload) => callback(payload)),
  onError: (callback) => ipcRenderer.on('assistant:error', (_event, payload) => callback(payload)),
  onPull: (callback) => ipcRenderer.on('assistant:pull', (_event, payload) => callback(payload)),
  onStatus: (callback) => ipcRenderer.on('assistant:status-push', (_event, payload) => callback(payload)),
});
