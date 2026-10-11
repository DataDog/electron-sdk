import '@datadog/electron-sdk/instrument';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import {
  _flushTransport,
  ElectronMainFlagsProvider,
  init,
  openFlagsChannel,
  type InitConfiguration,
} from '@datadog/electron-sdk';
import { OpenFeature } from '@openfeature/web-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Feature flags in a forked ELECTRON_RUN_AS_NODE child (M6): frames ride the app's own protocol.
let flagsChild: ChildProcess | undefined;
const pendingChildEvaluations = new Map<number, (result: unknown) => void>();
let nextChildEvaluationId = 1;

function getFlagsChild(): ChildProcess {
  if (flagsChild) return flagsChild;
  const child = fork(join(__dirname, 'flags-child.mjs'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    execArgv: [],
    silent: true,
  });
  const channel = openFlagsChannel({
    kind: 'frames',
    name: 'integration-child',
    owner: child,
    send: (frame) => child.send({ type: 'dd-flags', frame }, () => undefined),
  });
  child.on('message', (message: { type?: string; frame?: unknown; id?: number }) => {
    if (message.type === 'dd-flags') {
      channel.receive(message.frame);
    } else if (message.type === 'evaluation' && typeof message.id === 'number') {
      pendingChildEvaluations.get(message.id)?.(message);
      pendingChildEvaluations.delete(message.id);
    }
  });
  child.on('exit', () => {
    flagsChild = undefined;
  });
  flagsChild = child;
  return child;
}

app.on('will-quit', () => flagsChild?.kill());

ipcMain.handle(
  'evaluateFlagInChild',
  (_event, flagKey: string, defaultValue: string) =>
    new Promise((resolve) => {
      const id = nextChildEvaluationId++;
      pendingChildEvaluations.set(id, resolve);
      getFlagsChild().send({ type: 'evaluate', id, flagKey, defaultValue });
    })
);

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
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      partition,
    },
  });

  void window.loadFile(join(__dirname, 'renderer/index.html'));
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
