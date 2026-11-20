'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The picker's whole vocabulary: one rectangle, or none.
contextBridge.exposeInMainWorld('regionAPI', {
  pick: (rect) => ipcRenderer.send('region:pick', rect),
  cancel: () => ipcRenderer.send('region:cancel'),
});
