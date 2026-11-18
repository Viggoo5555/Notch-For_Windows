'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notchAPI', {
  bootstrap: () => ipcRenderer.invoke('notch:bootstrap'),
  setExpanded: (value) => ipcRenderer.send('notch:expanded', !!value),
  setPinned: (value) => ipcRenderer.send('notch:pinned', !!value),
  focus: () => ipcRenderer.send('notch:focus'),
  quit: () => ipcRenderer.send('notch:quit'),
  setLogin: (value) => ipcRenderer.invoke('notch:login', !!value),
  rescan: () => ipcRenderer.invoke('notch:rescan'),
  addGame: () => ipcRenderer.invoke('notch:add-game'),
  launch: (id) => ipcRenderer.invoke('notch:launch', id),
  copyClip: (id) => ipcRenderer.invoke('notch:copy-clip', id),
  ready: () => ipcRenderer.send('notch:ready'),
  detachTile: (payload) => ipcRenderer.send('notch:detach', payload),
  detail: (kind) => ipcRenderer.send('notch:detail', kind),
  focusState: (state) => ipcRenderer.send('focus:state', state),
  detachEnd: () => ipcRenderer.send('notch:detach-end'),
  setSettings: (patch) => ipcRenderer.invoke('notch:set-settings', patch),
  pickWallpaper: () => ipcRenderer.invoke('notch:pick-wallpaper'),
  onBackdrop: (callback) => ipcRenderer.on('notch:backdrop', (_event, data) => callback(data)),
  onIcons: (callback) => ipcRenderer.on('notch:icons', (_event, data) => callback(data)),
  onPointer: (callback) => ipcRenderer.on('notch:pointer', (_event, state) => callback(state)),
  onStats: (callback) => ipcRenderer.on('notch:stats', (_event, data) => callback(data)),
  onClips: (callback) => ipcRenderer.on('notch:clips', (_event, data) => callback(data)),
  onProcesses: (callback) => ipcRenderer.on('notch:processes', (_event, data) => callback(data)),
  onFocusAction: (callback) => ipcRenderer.on('notch:focus-action', (_event, action) => callback(action)),
  onTogglePin: (callback) => ipcRenderer.on('notch:toggle-pin', () => callback()),
  onOpen: (callback) => ipcRenderer.on('notch:open', () => callback()),
});
