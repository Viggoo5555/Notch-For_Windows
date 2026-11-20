'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  boot: () => ipcRenderer.invoke('assistant:boot'),
  status: () => ipcRenderer.invoke('assistant:status'),
  startEngine: () => ipcRenderer.invoke('assistant:start'),
  installEngine: () => ipcRenderer.invoke('assistant:install'),
  onInstall: (callback) => ipcRenderer.on('assistant:install', (_event, data) => callback(data)),
  chat: (payload) => ipcRenderer.invoke('assistant:chat', payload),
  warm: () => ipcRenderer.invoke('assistant:warm'),
  act: (text, content) => ipcRenderer.invoke('assistant:act', text, content),
  hardware: () => ipcRenderer.invoke('assistant:hardware'),
  stop: () => ipcRenderer.send('assistant:stop'),
  pull: (name) => ipcRenderer.invoke('assistant:pull', name),
  remove: (name) => ipcRenderer.invoke('assistant:remove', name),
  voices: () => ipcRenderer.invoke('assistant:voices'),
  speak: (text) => ipcRenderer.invoke('assistant:speak', text),
  speakNeural: (text) => ipcRenderer.invoke('assistant:speak-neural', text),
  warmVoice: () => ipcRenderer.invoke('assistant:warm-voice'),
  voiceState: (payload) => ipcRenderer.send('voice:hud', payload),
  voiceLevel: (value) => ipcRenderer.send('voice:level', value),
  hush: () => ipcRenderer.send('assistant:hush'),
  save: (patch) => ipcRenderer.invoke('assistant:settings', patch),
  open: (url) => ipcRenderer.invoke('assistant:open', url),
  hide: () => ipcRenderer.send('assistant:hide'),
  onDelta: (callback) => ipcRenderer.on('assistant:delta', (_event, text) => callback(text)),
  onDone: (callback) => ipcRenderer.on('assistant:done', (_event, payload) => callback(payload)),
  onError: (callback) => ipcRenderer.on('assistant:error', (_event, payload) => callback(payload)),
  onPull: (callback) => ipcRenderer.on('assistant:pull', (_event, payload) => callback(payload)),
  onStatus: (callback) => ipcRenderer.on('assistant:status-push', (_event, payload) => callback(payload)),
  // The strip of desktop behind the window, for its liquid-glass lens.
  onBackdrop: (callback) => ipcRenderer.on('jarvis:backdrop', (_event, data) => callback(data)),
  // A game has the screen: stop listening until it is over.
  onGameMode: (callback) => ipcRenderer.on('jarvis:game-mode', (_event, on) => callback(!!on)),
});
