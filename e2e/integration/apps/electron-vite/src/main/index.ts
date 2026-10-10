import '@datadog/electron-sdk/instrument';
import { ElectronMainFlagsProvider } from '@datadog/electron-sdk';
import { OpenFeature } from '@openfeature/web-sdk';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { _flushTransport, init, type InitConfiguration } from '@datadog/electron-sdk';

const isDebugMode = process.env.PWDEBUG === '1';
let mainWindow: BrowserWindow | null = null;
let customSessionWindow: BrowserWindow | null = null;

void init(getConfiguration());

void OpenFeature.setProviderAndWait(new ElectronMainFlagsProvider()).catch(() => undefined);

ipcMain.handle(\'evaluateFlag\', (_event: \'boolean\' | \'string\', flagKey: string, defaultValue: unknown) => {
  const client = OpenFeature.getClient();
  if (_event === \'boolean\') {
    const d = client.getBooleanDetails(flagKey, defaultValue as boolean);
    return { value: d.value, variant: d.variant, errorCode: d.errorCode };
  }
  const d = client.getStringDetails(flagKey, defaultValue as string);
  return { value: d.value, variant: d.variant, errorCode: d.errorCode };
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
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
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
