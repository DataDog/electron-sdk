// Must be imported before 'electron' — instruments electron for tracing and preload injection.
import '@datadog/electron-sdk/instrument';

import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import * as path from 'node:path';
import * as https from 'node:https';
import {
  init,
  addError,
  stopSession,
  _flushTransport,
  getInternalContext,
  addDurationVital,
  startDurationVital,
  stopDurationVital,
  startOperation,
  succeedOperation,
  failOperation,
  setGlobalContext,
  setGlobalContextProperty,
  removeGlobalContextProperty,
  clearGlobalContext,
  setUserInfo,
  clearUserInfo,
  addUserExtraInfo,
  setAccountInfo,
  clearAccountInfo,
  addAccountExtraInfo,
  getUserInfo,
  getAccountInfo,
  type AddDurationVitalOptions,
  type DurationVitalOptions,
  type FailureReason,
  type FeatureOperationOptions,
} from '@datadog/electron-sdk';
import { loadWindowState, saveWindowState } from './main/windowState';
import { setupHotReload } from './main/hotReload';
import { buildRumExplorerUrl } from './main/utils';
import { readPlaygroundVersion } from './main/version';
import { getActiveConf } from './main/conf';
import { getRendererProtocol, setupRendererProtocol } from './main/rendererProtocol';
import { generateError } from './main/generateError';

const activeConf = getActiveConf();
const rendererProtocol = getRendererProtocol();
const isTestMode = process.env.DD_TEST_MODE === '1';

let mainWindow: BrowserWindow | null = null;
let secondaryWindow: BrowserWindow | null = null;
let rendererBaseUrl = 'app://app/';

// Serving the renderer over a custom scheme (instead of file://) lets us attach the `Document-Policy: js-profiling`
// response header, which is required to enable the JS Self-Profiling API. The scheme must be registered as
// privileged before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

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

  void mainWindow.loadURL(`${rendererBaseUrl}index.html`);

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

let telemetryErrorCount = 0;
ipcMain.handle('generateTelemetryError', () => {
  // Provoke an SDK-internal error through a public API: `setAccountInfo` deep-clones its argument, so a
  // throwing getter surfaces as a monitored error and produces one error telemetry event. The counter
  // varies the message, since telemetry deduplicates identical events per session.
  const discriminator = telemetryErrorCount++;
  setAccountInfo({
    id: 'telemetry-error',
    get name(): string {
      throw new Error(`expected error ${discriminator}`);
    },
  });
});

// IPC handler to generate uncaught exception
ipcMain.handle('generateUncaughtException', () => {
  setTimeout(() => {
    generateError();
  });
});

// IPC handler to generate unhandled rejection
ipcMain.handle('generateUnhandledRejection', () => {
  void Promise.reject(new Error('test unhandled rejection'));
});

ipcMain.handle('main:before-send-error', (_event, behavior: 'scrub' | 'filter') => {
  addError(new Error('Sensitive error for beforeSendRum'), {
    context: { beforeSend: behavior, email: 'customer@example.com' },
  });
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

async function fetchWithNet(): Promise<unknown> {
  const res = await net.fetch('https://httpbin.org/json');
  return (await res.json()) as unknown;
}

ipcMain.handle('main:fetch-api-net', fetchWithNet);
ipcMain.handle('main:fetch-api-net-drop', fetchWithNet);

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

// --- Global context handlers ---

ipcMain.handle('main:set-global-context', () => {
  setGlobalContext({ team: 'checkout', build: '1.2.3' });
});

ipcMain.handle('main:set-global-context-property', () => {
  setGlobalContextProperty('feature_flag', 'new-cart');
});

ipcMain.handle('main:remove-global-context-property', () => {
  removeGlobalContextProperty('feature_flag');
});

ipcMain.handle('main:clear-global-context', () => {
  clearGlobalContext();
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

// --- Usage telemetry demo handlers ---
// The getters report usage telemetry too, so they are worth a button of their own.

ipcMain.handle('main:get-user-info', () => getUserInfo());

ipcMain.handle('main:get-account-info', () => getAccountInfo());

ipcMain.handle('main:add-error', () => {
  addError(new Error('Playground error from addError()'));
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

// needed for automated tests
ipcMain.handle('flush-transport', async () => {
  await _flushTransport();
});

ipcMain.handle('open-rum-explorer', () => {
  const ctx = getInternalContext();
  if (!ctx) return;
  void shell.openExternal(buildRumExplorerUrl(activeConf, ctx.session_id));
});

ipcMain.handle('main:open-secondary-window', () => {
  if (secondaryWindow) return;
  secondaryWindow = new BrowserWindow({
    width: 500,
    height: 400,
    title: 'Secondary Renderer Process',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  void secondaryWindow.loadURL(`${rendererBaseUrl}secondary.html`);
  secondaryWindow.on('closed', () => {
    secondaryWindow = null;
  });
});

void app
  .whenReady()
  .then(async () => {
    // Initialize SDK on app ready (before window creation)
    console.log('Initializing SDK from main process...');
    const result = await init({
      ...activeConf,
      service: 'playground-main',
      version: readPlaygroundVersion(),
      env: 'dev',
      traceSamplingRules: [{ name: 'electron.main.handle', resource: 'main:fetch-api-net-drop', sampleRate: 0 }],
      sessionReplaySampleRate: 100,
      profilingSampleRate: 100,
      beforeSendRum: (event) => {
        if (event.context?.beforeSend === 'filter') {
          return false;
        }
        if (event.type === 'error' && event.context?.beforeSend === 'scrub') {
          event.error.message = '[REDACTED by beforeSendRum]';
          event.error.stack = '[REDACTED by beforeSendRum]';
          event.context = { email: '[REDACTED]' };
        }
        return true;
      },
      telemetrySampleRate: 100,
      telemetryConfigurationSampleRate: 100,
      telemetryUsageSampleRate: 100,
      allowedRendererHosts: ['*'],
      defaultPrivacyLevel: 'allow',
      enableExecutionContext: true,
      ...(process.env.DD_SDK_PROXY ? { proxy: process.env.DD_SDK_PROXY } : {}),
    });
    console.log('SDK init result:', result);

    rendererBaseUrl = await setupRendererProtocol(rendererProtocol);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((err: unknown) => {
    console.error(err);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Enable hot reload (playground is dev-only)
setupHotReload();
