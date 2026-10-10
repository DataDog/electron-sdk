import '@datadog/electron-sdk/instrument';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { _flushTransport, ElectronMainFlagsProvider, init, type InitConfiguration } from '@datadog/electron-sdk';
import { OpenFeature } from '@openfeature/web-sdk';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const isDebugMode = process.env.PWDEBUG === '1';
let mainWindow: BrowserWindow | null = null;
let customSessionWindow: BrowserWindow | null = null;

void init(getConfiguration());

// Feature flags: the main provider owns the evaluation context. It is registered right away,
// before init() settles, and becomes ready once the rules are served.
void OpenFeature.setProviderAndWait(new ElectronMainFlagsProvider(), { targetingKey: 'user-pro', plan: 'pro' }).catch(
  () => undefined
);

ipcMain.handle('evaluateFlag', (_event, flagKey: string, defaultValue: string) => {
  const details = OpenFeature.getClient().getStringDetails(flagKey, defaultValue);
  return { value: details.value, variant: details.variant, errorCode: details.errorCode };
});

ipcMain.handle('flushTransport', async () => {
  await _flushTransport();
});

ipcMain.handle('crash', () => {
  process.crash();
});

ipcMain.handle('mainFetch', async (_event, url: string) => {
  const res = await fetch(url);
  await res.text();
  return res.status;
});

// Opens a window on a non-default session to exercise custom-session preload injection.
ipcMain.handle('openCustomSessionWindow', () => {
  customSessionWindow = createWindow('persist:dd-custom-session');
});

void app.whenReady().then(() => {
  mainWindow = createWindow();
});

function createWindow(partition?: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    show: isDebugMode,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  return window;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function getConfiguration(): InitConfiguration {
  if (process.env.DD_SDK_CONFIG) {
    return JSON.parse(process.env.DD_SDK_CONFIG) as InitConfiguration;
  }
  throw new Error('DD_SDK_CONFIG environment variable is not set');
}
