// Must be imported before 'electron' — instruments electron for tracing and preload injection.
import '@datadog/electron-sdk/instrument';

import { app, BrowserWindow, ipcMain, net, shell } from 'electron';
import * as path from 'node:path';
import * as https from 'node:https';
import {
  init,
  stopSession,
  _flushTransport,
  getInternalContext,
  _generateTelemetryError,
  startOperation,
  succeedOperation,
  failOperation,
  type FailureReason,
  type FeatureOperationOptions,
} from '@datadog/electron-sdk';
import { loadWindowState, saveWindowState } from './main/windowState';
import { setupHotReload } from './main/hotReload';
import { buildRumExplorerUrl } from './main/utils';

const isTestMode = process.env.DD_TEST_MODE === '1';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: savedState?.width ?? 1024,
    height: savedState?.height ?? 768,
    x: savedState?.x,
    y: savedState?.y,
    show: !isTestMode,
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

// IPC handler to get internal context
ipcMain.handle('get-internal-context', () => getInternalContext());

ipcMain.handle('stop-session', () => {
  stopSession();
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

ipcMain.handle('main:fetch-api-fetch', async () => {
  const res = await fetch('https://httpbin.org/json');
  return (await res.json()) as unknown;
});

ipcMain.handle('main:fetch-api-net', async () => {
  const res = await net.fetch('https://httpbin.org/json');
  return (await res.json()) as unknown;
});

// IPC handler to crash the main process
ipcMain.handle('crash', () => {
  process.crash();
});

// --- Operation Monitoring demo handlers ---

ipcMain.handle('main:start-operation', (_event, name: string, options?: FeatureOperationOptions) => {
  startOperation(name, options);
});

ipcMain.handle('main:succeed-operation', (_event, name: string, options?: FeatureOperationOptions) => {
  succeedOperation(name, options);
});

ipcMain.handle(
  'main:fail-operation',
  (_event, name: string, failureReason: FailureReason, options?: FeatureOperationOptions) => {
    failOperation(name, failureReason, options);
  }
);

const ACTIVE_ENV = 'staging';
const CONF = {
  staging: {
    applicationId: '6efd3722-af0a-4070-994c-0e87076d4814',
    clientToken: 'pub2a7307cdec74934cacb411a193f632f8',
    site: 'datad0g.com',
  },
  prod: {
    applicationId: '0f574f27-317e-4223-b5b6-c935b4c83700',
    clientToken: 'pub09a54e493460355ef58c0c617d577e19',
    site: 'datadoghq.com',
  },
};

// needed for automated tests
ipcMain.handle('flush-transport', async () => {
  await _flushTransport();
});

ipcMain.handle('open-rum-explorer', () => {
  const ctx = getInternalContext();
  if (!ctx) return;
  void shell.openExternal(buildRumExplorerUrl(CONF[ACTIVE_ENV], ctx.session_id));
});

void app.whenReady().then(async () => {
  // Initialize SDK on app ready (before window creation)
  console.log('Initializing SDK from main process...');
  const result = await init({
    ...CONF[ACTIVE_ENV],
    service: 'electron-playground',
    env: 'dev',
    ...(process.env.DD_SDK_PROXY ? { proxy: process.env.DD_SDK_PROXY } : {}),
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
