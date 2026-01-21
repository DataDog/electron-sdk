import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { init } from '@datadog/electron-sdk';
import { loadWindowState, saveWindowState } from './main/windowState';
import { setupHotReload } from './main/hotReload';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: savedState?.width ?? 1024,
    height: savedState?.height ?? 768,
    x: savedState?.x,
    y: savedState?.y,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Always open DevTools (playground is dev-only)
  mainWindow.webContents.openDevTools();

  // Save window state before reload or close
  mainWindow.on('close', () => {
    if (mainWindow) {
      saveWindowState(mainWindow);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handler to initialize SDK from renderer
ipcMain.handle('init-sdk', () => {
  console.log('Initializing SDK from main process (triggered by button)...');
  const result = init({
    proxy: 'https://browser-intake-datadoghq.com',
    clientToken: 'playground-token',
    service: 'playground-app',
    env: 'development',
  });
  console.log('SDK init result:', result);
  return result;
});

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Enable hot reload (playground is dev-only)
setupHotReload();
