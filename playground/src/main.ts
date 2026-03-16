import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as https from 'node:https';
import { init, stopSession, _generateActivity, _generateTelemetryError } from '@datadog/electron-sdk';
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

ipcMain.handle('stop-session', () => {
  stopSession();
});

ipcMain.handle('generate-activity', () => {
  _generateActivity();
});

ipcMain.handle('generateTelemetryError', () => {
  _generateTelemetryError();
});

// IPC handler to generate uncaught exception
ipcMain.handle('generateUncaughtException', () => {
  setTimeout(() => {
    throw new Error('test uncaught exception');
  });
});

// IPC handler to generate unhandled rejection
ipcMain.handle('generateUnhandledRejection', () => {
  void Promise.reject(new Error('test unhandled rejection'));
});
// --- IPC demo handlers (each one becomes a captured IPC resource) ---

ipcMain.handle('main:fetch-api', async () => {
  const data = await new Promise<string>((resolve, reject) => {
    https
      .get('https://httpbin.org/json', (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      })
      .on('error', reject);
  });
  return JSON.parse(data) as unknown;
});

// IPC handler to crash the main process
ipcMain.handle('crash', () => {
  process.crash();
});

void app.whenReady().then(async () => {
  // Initialize SDK on app ready (before window creation)
  console.log('Initializing SDK from main process...');
  const CONF = {
    staging: {
      applicationId: '6efd3722-af0a-4070-994c-0e87076d4814',
      clientToken: 'pub2a7307cdec74934cacb411a193f632f8',
      site: 'datad0g.com',
    },
    prod: {
      applicationId: '75581b33-6cfb-4a61-985c-8d309adfe5f6',
      clientToken: 'pubf39340763f9ff434d09ac1bee2eae5c9',
      site: 'datadoghq.com',
    },
  };
  const result = await init({
    ...CONF.staging,
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
