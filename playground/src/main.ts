import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { init } from '@datadog/electron-sdk';
import { loadWindowState, saveWindowState } from './main/windowState';
import { setupHotReload } from './main/hotReload';

let mainWindow: BrowserWindow | null = null;

function getSessionFilePath(): string {
  return path.join(app.getPath('userData'), '_dd_s');
}

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

// IPC handler to get session file content
ipcMain.handle('get-session-file', () => {
  const sessionFilePath = getSessionFilePath();
  try {
    if (fs.existsSync(sessionFilePath)) {
      const content = fs.readFileSync(sessionFilePath, 'utf-8');
      return content;
    }
    return null;
  } catch (error) {
    console.error('Error reading session file:', error);
    return null;
  }
});

// IPC handler to clear session file
ipcMain.handle('clear-session-file', () => {
  const sessionFilePath = getSessionFilePath();
  try {
    if (fs.existsSync(sessionFilePath)) {
      fs.unlinkSync(sessionFilePath);
      console.log('Session file deleted:', sessionFilePath);
    }
  } catch (error) {
    console.error('Error deleting session file:', error);
  }
});

void app.whenReady().then(() => {
  // Initialize SDK on app ready (before window creation)
  console.log('Initializing SDK from main process...');
  const result = init({
    applicationId: '6efd3722-af0a-4070-994c-0e87076d4814',
    clientToken: 'pub2a7307cdec74934cacb411a193f632f8',
    site: 'datad0g.com',
    service: 'electron-playground',
    env: 'dev',
  });
  console.log('SDK init result:', result);

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
