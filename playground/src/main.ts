// Must be imported before 'electron' — instruments electron for tracing and preload injection.
import '@datadog/electron-sdk/instrument';

import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as https from 'node:https';
import {
  init,
  stopSession,
  _flushTransport,
  getInternalContext,
  _generateTelemetryError,
  addError,
  addDurationVital,
  startDurationVital,
  stopDurationVital,
  startOperation,
  succeedOperation,
  failOperation,
  setUserInfo,
  clearUserInfo,
  addUserExtraInfo,
  setAccountInfo,
  clearAccountInfo,
  addAccountExtraInfo,
  type AddDurationVitalOptions,
  type DurationVitalOptions,
  type FailureReason,
  type FeatureOperationOptions,
} from '@datadog/electron-sdk';
import { loadWindowState, saveWindowState } from './main/windowState';
import { setupHotReload } from './main/hotReload';
import { buildRumExplorerUrl } from './main/utils';

const isTestMode = process.env.DD_TEST_MODE === '1';

let mainWindow: BrowserWindow | null = null;

// Serving the renderer over a custom scheme (instead of file://) lets us attach the `Document-Policy: js-profiling`
// response header, which is required to enable the JS Self-Profiling API. The scheme must be registered as
// privileged before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveRendererOverAppProtocol(): void {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const fileName = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const ext = fileName.split('.').pop();
    const contentType =
      ext === 'html'
        ? 'text/html'
        : ext === 'js'
          ? 'application/javascript'
          : ext === 'map'
            ? 'application/json'
            : 'application/octet-stream';
    const headers: Record<string, string> = { 'Content-Type': contentType };
    // Only the HTML document needs the policy that enables the profiler.
    if (ext === 'html') {
      headers['Document-Policy'] = 'js-profiling';
    }
    return new Response(fs.readFileSync(path.join(__dirname, fileName)), { headers });
  });
}

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

  void mainWindow.loadURL('app://app/');

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

ipcMain.handle('ipc-demo:get-profile', async () => {
  const res = await fetch('https://httpbin.org/json');
  return (await res.json()) as unknown;
});

ipcMain.handle('ipc-demo:get-profile-with-progress', async () => {
  mainWindow?.webContents.send('ipc-demo:profile-progress', { status: 'fetching' });
  startDurationVital('profile.fetch');
  const res = await fetch('https://httpbin.org/json');
  stopDurationVital('profile.fetch');
  return (await res.json()) as unknown;
});

ipcMain.on('ipc-demo:ping-main', () => {
  void fetch('https://httpbin.org/json').catch(() => undefined);
});
ipcMain.on('ipc-demo:ping-main', () => {
  void fetch('https://httpbin.org/uuid').catch(() => undefined);
  addError(new Error('ping-main listener #2 failed'), { context: { scenario: 'ipc-demo:ping-main' } });
});

ipcMain.handle('ipc-demo:trigger-ping-renderer', () => {
  void fetch('https://httpbin.org/json').catch(() => undefined);
  mainWindow?.webContents.send('ipc-demo:ping-renderer', { from: 'main' });
});

let broadcastWindows: BrowserWindow[] = [];

// Opening the helper windows is its own explicit user action (the "Open broadcast windows" button),
// separate from actually broadcasting. This keeps the broadcast handler itself fully synchronous — no
// await between receiving the trigger and relaying to each window — which matters for two reasons:
// (1) by the time a user can click "Broadcast", the windows the earlier click already opened are
// guaranteed loaded (`loadURL` resolves once the page has finished loading, by which point the
// renderer's synchronous top-level script — including its ipcRenderer.on registration — has already
// run), so Electron never silently drops a send aimed at a not-yet-registered listener; and (2) a
// synchronous handler keeps the relay sends within the same ambient IPC context as the trigger call,
// so they correctly inherit it as their parent (see src/domain/tracing/ipcParentContext.ts) — an
// `await` between the trigger and the relay would clear that context before the sends fire.
ipcMain.handle('ipc-demo:open-broadcast-windows', async () => {
  if (broadcastWindows.length > 0) return; // already opened, idempotent
  broadcastWindows = [0, 1].map(
    () =>
      new BrowserWindow({
        width: 400,
        height: 300,
        show: !isTestMode,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          preload: path.join(__dirname, 'preload.js'),
        },
      })
  );
  await Promise.all(broadcastWindows.map((win) => win.loadURL('app://app/')));
});

ipcMain.handle('ipc-demo:broadcast', (_event, data: unknown) => {
  void fetch('https://httpbin.org/json').catch(() => undefined);
  for (const win of broadcastWindows) {
    win.webContents.send('ipc-demo:broadcast-received', data);
  }
});

// IPC handler to crash the main process
ipcMain.handle('crash', () => {
  process.crash();
});

// --- Custom duration vital demo handlers ---

ipcMain.handle('main:add-duration-vital', (_event, name: string, options: AddDurationVitalOptions) => {
  addDurationVital(name, options);
});

ipcMain.handle('main:start-duration-vital', (_event, name: string, options?: DurationVitalOptions) => {
  startDurationVital(name, options);
});

ipcMain.handle('main:stop-duration-vital', (_event, name: string, options?: DurationVitalOptions) => {
  stopDurationVital(name, options);
});

// --- User & Account context handlers ---

ipcMain.handle('main:set-user-info', () => {
  setUserInfo({ id: 'user-playground', name: 'Playground User', email: 'playground@example.com' });
});

ipcMain.handle('main:add-user-extra-info', () => {
  addUserExtraInfo({ plan: 'premium' });
});

ipcMain.handle('main:clear-user-info', () => {
  clearUserInfo();
});

ipcMain.handle('main:set-account-info', () => {
  setAccountInfo({ id: 'account-playground', name: 'Playground Corp' });
});

ipcMain.handle('main:add-account-extra-info', () => {
  addAccountExtraInfo({ tier: 'enterprise' });
});

ipcMain.handle('main:clear-account-info', () => {
  clearAccountInfo();
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

const ACTIVE_ENV = 'prod';
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
    sessionReplaySampleRate: 100,
    profilingSampleRate: 100,
    allowedRendererHosts: ['*'],
    defaultPrivacyLevel: 'allow',
    ...(process.env.DD_SDK_PROXY ? { proxy: process.env.DD_SDK_PROXY } : {}),
  });
  console.log('SDK init result:', result);

  serveRendererOverAppProtocol();
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
