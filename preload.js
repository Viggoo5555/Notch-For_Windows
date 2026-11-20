'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notchAPI', {
  bootstrap: () => ipcRenderer.invoke('notch:bootstrap'),
  setExpanded: (value) => ipcRenderer.send('notch:expanded', !!value),
  setCollapsing: (ms) => ipcRenderer.send('notch:collapsing', ms),
  // How wide the folded pill actually came out, so the hover rect can follow it.
  pillWidth: (px) => ipcRenderer.send('notch:pill-width', px),
  setPinned: (value) => ipcRenderer.send('notch:pinned', !!value),
  focus: () => ipcRenderer.send('notch:focus'),
  quit: () => ipcRenderer.send('notch:quit'),
  setLogin: (value) => ipcRenderer.invoke('notch:login', !!value),
  rescan: () => ipcRenderer.invoke('notch:rescan'),
  // The store pages through Steam's search: one answer per screenful.
  storePage: (options) => ipcRenderer.invoke('notch:store-page', options || {}),
  openStorePage: (appid) => ipcRenderer.invoke('notch:store-open', appid),
  addGame: () => ipcRenderer.invoke('notch:add-game'),
  removeGame: (id) => ipcRenderer.invoke('notch:remove-game', id),
  launch: (id) => ipcRenderer.invoke('notch:launch', id),
  copyClip: (id) => ipcRenderer.invoke('notch:copy-clip', id),
  ready: () => ipcRenderer.send('notch:ready'),
  detachTile: (payload) => ipcRenderer.send('notch:detach', payload),
  cursorPos: () => ipcRenderer.invoke('notch:cursor'),
  prewarmTile: (tile) => ipcRenderer.send('notch:prewarm-tile', tile),
  // Where the pointer is, so the glass can take it out of the picture.
  overlay: () => ipcRenderer.invoke('notch:overlay'),
  detail: (kind) => ipcRenderer.send('notch:detail', kind),
  focusState: (state) => ipcRenderer.send('focus:state', state),
  detachEnd: () => ipcRenderer.send('notch:detach-end'),
  setSettings: (patch) => ipcRenderer.invoke('notch:set-settings', patch),
  pickWallpaper: () => ipcRenderer.invoke('notch:pick-wallpaper'),
  onBackdrop: (callback) => ipcRenderer.on('notch:backdrop', (_event, data) => callback(data)),
  // The live desktop: which screen to stream, whether it should be running, and
  // whether the stream actually came up (so main knows to fall back or not).
  captureSource: () => ipcRenderer.invoke('notch:capture-source'),
  liveActive: (value) => ipcRenderer.send('notch:live-active', !!value),
  onLive: (callback) => ipcRenderer.on('notch:live', (_event, value) => callback(!!value)),
  onIcons: (callback) => ipcRenderer.on('notch:icons', (_event, data) => callback(data)),
  onPointer: (callback) => ipcRenderer.on('notch:pointer', (_event, state) => callback(state)),
  onStats: (callback) => ipcRenderer.on('notch:stats', (_event, data) => callback(data)),
  onClips: (callback) => ipcRenderer.on('notch:clips', (_event, data) => callback(data)),
  onProcesses: (callback) => ipcRenderer.on('notch:processes', (_event, data) => callback(data)),
  onFocusAction: (callback) => ipcRenderer.on('notch:focus-action', (_event, action) => callback(action)),
  onTogglePin: (callback) => ipcRenderer.on('notch:toggle-pin', () => callback()),
  onOpen: (callback) => ipcRenderer.on('notch:open', () => callback()),
  // Jarvis changes the app from the main process, so the panel is told.
  onSettings: (callback) => ipcRenderer.on('notch:settings', (_event, data) => callback(data)),
  onView: (callback) => ipcRenderer.on('notch:view', (_event, kind) => callback(kind)),
  onGames: (callback) => ipcRenderer.on('notch:games', (_event, list) => callback(list)),
  // Screenshots: one capture, then the three things offered under the preview.
  captureShot: () => ipcRenderer.invoke('notch:shot-capture'),
  saveShot: () => ipcRenderer.invoke('notch:shot-save'),
  shotText: () => ipcRenderer.invoke('notch:shot-text'),
  shotFont: () => ipcRenderer.invoke('notch:shot-font'),
  onShot: (callback) => ipcRenderer.on('notch:shot', (_event, data) => callback(data)),
  // Updates: one check against the releases, then a download the panel watches.
  checkUpdate: () => ipcRenderer.invoke('notch:update-check'),
  installUpdate: () => ipcRenderer.invoke('notch:update-install'),
  openUpdatePage: () => ipcRenderer.send('notch:update-page'),
  onUpdate: (callback) => ipcRenderer.on('notch:update', (_event, data) => callback(data)),
  onUpdateProgress: (callback) =>
    ipcRenderer.on('notch:update-progress', (_event, data) => callback(data)),
});
