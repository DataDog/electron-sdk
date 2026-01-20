import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { init } from '@datadog/electron-sdk';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void mainWindow.loadFile(join(__dirname, 'index.html'));
}

// IPC handler for SDK initialization
ipcMain.handle('init-sdk', () => {
  try {
    const result = init();
    return { success: true, result };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

void app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
