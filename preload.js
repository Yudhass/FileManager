// preload.js - jembatan aman antara UI dan proses desktop (Electron)
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  version: '1.1.0',
  mode: 'desktop'
});
