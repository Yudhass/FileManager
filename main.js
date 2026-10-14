// main.js - Electron Main Process (aplikasi DESKTOP, bukan browser)
// Membungkus web app menjadi jendela desktop sesuai PRD.
// Backend Node.js (server.js) dijalankan di dalam proses ini,
// UI dual-pane dirender oleh Chromium bawaan Electron.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const { startServer } = require('./server');

const PORT = Number(process.env.PORT) || 4821;
let win = null;

async function createWindow() {
  await startServer(PORT);

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    title: 'Dual-Pane Fast File Manager',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);
  win.loadURL(`http://127.0.0.1:${PORT}`);

  // Link eksternal (jika ada) dibuka di browser luar, bukan di dalam app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
