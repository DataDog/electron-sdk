import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import {
  init,
  addError,
  _generateTelemetryError,
  _generateActivity,
  _flushTransport,
  stopSession,
  type InitConfiguration,
} from '@datadog/electron-sdk';

let mainWindow: BrowserWindow | null = null;

void app.whenReady().then(async () => {
  const config = getConfiguration();
  console.log('Initializing SDK with config:', config);
  const initialized = await init(config);
  console.log('SDK initialized:', initialized);

  ipcMain.handle('generateTelemetryErrors', (_event, count: number) => {
    for (let i = 0; i < count; i++) {
      _generateTelemetryError();
    }
  });

  ipcMain.handle('stopSession', () => {
    stopSession();
  });

  ipcMain.handle('generateActivity', () => {
    _generateActivity();
  });

  ipcMain.handle('generateUncaughtException', () => {
    setTimeout(() => {
      throw new Error('test uncaught exception');
    });
  });

  ipcMain.handle('generateUnhandledRejection', () => {
    void Promise.reject(new Error('test unhandled rejection'));
  });

  ipcMain.handle('generateManualError', (_event, startTime?: number) => {
    addError(new Error('test manual error'), { context: { foo: 'bar' }, startTime });
  });

  ipcMain.handle('flushTransport', async () => {
    await _flushTransport();
  });

  ipcMain.handle('crash', () => {
    process.crash();
  });

  createWindow();
});

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

function createWindow() {
  // Show window only in debug mode (when Playwright's --debug flag is used)
  const isDebugMode = process.env.PWDEBUG === '1';

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: isDebugMode, // Hidden by default, visible in debug mode
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void mainWindow.loadFile(join(__dirname, 'index.html'));
}

function getConfiguration(): InitConfiguration {
  if (process.env.DD_SDK_CONFIG) {
    return JSON.parse(process.env.DD_SDK_CONFIG) as InitConfiguration;
  }
  throw new Error('DD_SDK_CONFIG environment variable is not set');
}
