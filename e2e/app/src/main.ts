import '@datadog/electron-sdk/instrument';
import { ElectronMainFlagsProvider } from '@datadog/electron-sdk';
import { OpenFeature } from '@openfeature/web-sdk';
import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A custom scheme must be registered as privileged (standard + secure) before app ready so that pages
// served through it can use the JS Self-Profiling API when the response carries the Document-Policy header.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let appProtocolRegistered = false;

function serveBridgeWindowOverAppProtocol(): void {
  if (appProtocolRegistered) {
    return;
  }
  appProtocolRegistered = true;
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const fileName = pathname === '/' ? 'bridge-window.html' : pathname.replace(/^\//, '');
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
    return new Response(fs.readFileSync(join(__dirname, fileName)), { headers });
  });
}
import {
  init,
  addError,
  _flushTransport,
  stopSession,
  getInternalContext,
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
  setGlobalContext,
  setGlobalContextProperty,
  removeGlobalContextProperty,
  clearGlobalContext,
  type FailureReason,
  type AddDurationVitalOptions,
  type DurationVitalOptions,
  type FeatureOperationOptions,
  type UserInfo,
  type AccountInfo,
  type InitConfiguration,
} from '@datadog/electron-sdk';

const isDebugMode = process.env.PWDEBUG === '1';
let mainWindow: BrowserWindow | null = null;
let testRendererWindow: BrowserWindow | null = null;
let rendererHttpServer: http.Server | null = null;
// Feature flags e2e: windows with the app preload (probes) on a chosen session, served over
// file:// or a local http origin so origin gating, navigation and partitions can be exercised.
const flagsWindows = new Map<number, BrowserWindow>();
let flagsHttpPort: number | undefined;

const noop = () => undefined;

type BeforeSendRum = NonNullable<InitConfiguration['beforeSendRum']>;

const e2eControls: {
  beforeSendRum: BeforeSendRum;
  init?: () => Promise<void>;
  openWindow?: () => void;
} = {
  beforeSendRum: () => true,
};

(globalThis as Record<string, unknown>).__ddE2E = e2eControls;

/** Serve the main window (with the renderer flags provider) over http on localhost. */
function startFlagsHttpServer(): Promise<number> {
  if (flagsHttpPort !== undefined) {
    return Promise.resolve(flagsHttpPort);
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const fileName =
        (req.url ?? '/').split('?')[0] === '/' ? 'main-window.html' : (req.url ?? '').split('?')[0].slice(1);
      try {
        const body = fs.readFileSync(join(__dirname, fileName));
        res.writeHead(200, { 'Content-Type': fileName.endsWith('.js') ? 'application/javascript' : 'text/html' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, () => {
      flagsHttpPort = (server.address() as { port: number }).port;
      resolve(flagsHttpPort);
    });
  });
}

type FlagsWindowLocation = 'file' | 'http-localhost' | 'http-127';

async function flagsWindowUrl(location: FlagsWindowLocation, marker: string): Promise<string> {
  if (location === 'file') {
    return `${pathToFileURL(join(__dirname, 'main-window.html')).href}?${marker}`;
  }
  const port = await startFlagsHttpServer();
  return `http://${location === 'http-localhost' ? 'localhost' : '127.0.0.1'}:${port}/?${marker}`;
}

function startRendererHttpServer(): Promise<number> {
  return new Promise((resolve) => {
    rendererHttpServer = http.createServer((_req, res) => {
      const htmlPath = join(__dirname, 'bridge-window.html');
      const jsPath = join(__dirname, 'bridge-window.js');

      if (_req.url === '/' || _req.url?.endsWith('.html')) {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html', 'Document-Policy': 'js-profiling' });
        res.end(html);
      } else if (_req.url?.endsWith('.js')) {
        const js = fs.readFileSync(jsPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(js);
      } else if (_req.url?.endsWith('.js.map')) {
        const mapPath = join(__dirname, 'bridge-window.js.map');
        try {
          const map = fs.readFileSync(mapPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(map);
        } catch {
          res.writeHead(404);
          res.end();
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    rendererHttpServer.listen(0, () => {
      const addr = rendererHttpServer!.address() as { port: number };
      resolve(addr.port);
    });
  });
}

void app.whenReady().then(async () => {
  const config = getConfiguration();
  // DD_E2E_DEFER_INIT reproduces the "init() gated behind user consent" flow: the SDK is instrumented
  // (preload registered) but init() does not run and no window opens at startup. The e2e drives init and
  // window creation from the main process via __ddE2E, so it can control the order of init vs window open
  // (there is no renderer yet to use IPC).
  let initialized = false;
  if (process.env.DD_E2E_DEFER_INIT === '1') {
    console.log('Deferring SDK init (DD_E2E_DEFER_INIT=1)');
    e2eControls.init = async () => {
      initialized = await init(config);
    };
    e2eControls.openWindow = () => createWindow();
  } else {
    console.log('Initializing SDK with config:', config);
    initialized = await init(config);
  }
  console.log('SDK initialized:', initialized);

  ipcMain.handle('generateTelemetryErrors', (_event, count: number) => {
    for (let i = 0; i < count; i++) {
      generateTelemetryError(i);
    }
  });

  ipcMain.handle('getSessionId', () => getInternalContext()?.session_id);

  ipcMain.handle('stopSession', () => {
    stopSession();
  });

  ipcMain.handle('generateUncaughtException', () => {
    setTimeout(() => {
      throw new Error('test uncaught exception');
    });
  });

  ipcMain.handle('generateUnhandledRejection', () => {
    void Promise.reject(new Error('test unhandled rejection'));
  });

  ipcMain.handle('generateManualError', (_event, startTime?: number, context?: Record<string, string>) => {
    addError(new Error('test manual error'), { context: context ?? { foo: 'bar' }, startTime });
  });

  ipcMain.handle('addDurationVital', (_event, name: string, options: AddDurationVitalOptions) => {
    addDurationVital(name, options);
  });

  ipcMain.handle('startDurationVital', (_event, name: string, options?: DurationVitalOptions) => {
    startDurationVital(name, options);
  });

  ipcMain.handle('stopDurationVital', (_event, name: string, options?: DurationVitalOptions) => {
    stopDurationVital(name, options);
  });

  ipcMain.handle('startOperation', (_event, name: string, options?: FeatureOperationOptions) => {
    startOperation(name, options);
  });

  ipcMain.handle('succeedOperation', (_event, name: string, options?: FeatureOperationOptions) => {
    succeedOperation(name, options);
  });

  ipcMain.handle(
    'failOperation',
    (_event, name: string, failureReason: FailureReason, options?: FeatureOperationOptions) => {
      failOperation(name, failureReason, options);
    }
  );

  ipcMain.handle('mainFetch', async (_event, url: string) => {
    const res = await fetch(url);
    await res.text();
    return res.status;
  });

  ipcMain.handle(
    'mainHttpRequest',
    (_event, url: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(url, (res) => {
          res.on('data', noop);
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      })
  );

  ipcMain.handle(
    'mainNetRequest',
    (_event, url: string) =>
      new Promise<number>((resolve, reject) => {
        const req = net.request(url);
        req.on('response', (res) => {
          res.on('data', noop);
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      })
  );

  ipcMain.handle('mainNetFetch', async (_event, url: string) => {
    const res = await net.fetch(url);
    await res.text();
    return res.status;
  });

  ipcMain.handle('registerFlagsProvider', async (_event, context?: Record<string, unknown>) => {
    const provider = new ElectronMainFlagsProvider();
    // Registration can reject while no configuration is available yet (e.g. a failing
    // endpoint); the provider still recovers when a later fetch succeeds.
    await OpenFeature.setProviderAndWait(provider).catch(() => undefined);
    if (context !== undefined) {
      await OpenFeature.setContext(context as never).catch(() => undefined);
    }
    return OpenFeature.getClient().providerStatus;
  });

  ipcMain.handle('setFlagsContext', (_event, context: Record<string, unknown>) => {
    return OpenFeature.setContext(context as never);
  });

  ipcMain.handle('evaluateFlag', (_event, type: 'boolean' | 'string', flagKey: string, defaultValue: unknown) => {
    const client = OpenFeature.getClient();
    if (type === 'boolean') {
      const details = client.getBooleanDetails(flagKey, defaultValue as boolean);
      return { value: details.value, variant: details.variant, reason: details.reason, errorCode: details.errorCode };
    }
    const details = client.getStringDetails(flagKey, defaultValue as string);
    return { value: details.value, variant: details.variant, reason: details.reason, errorCode: details.errorCode };
  });

  ipcMain.handle('getFlagsProviderStatus', () => OpenFeature.getClient().providerStatus);

  ipcMain.handle(
    'openFlagsWindow',
    async (_event, options: { partition?: string; location?: FlagsWindowLocation; marker: string }) => {
      const win = new BrowserWindow({
        width: 600,
        height: 400,
        show: isDebugMode,
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          ...(options.partition !== undefined ? { partition: options.partition } : {}),
        },
      });
      flagsWindows.set(win.id, win);
      win.on('closed', () => flagsWindows.delete(win.id));
      await win.loadURL(await flagsWindowUrl(options.location ?? 'file', options.marker));
      return win.id;
    }
  );

  // Evaluates in a flags window from main: Playwright cannot drive a page whose renderer crashed,
  // even after its webContents reloaded.
  ipcMain.handle('evaluateInFlagsWindow', (_event, id: number, flagKey: string) =>
    flagsWindows
      .get(id)
      ?.webContents.executeJavaScript(`window.__rendererEvaluateFlag('string', ${JSON.stringify(flagKey)}, 'default')`)
  );

  ipcMain.handle('navigateFlagsWindow', async (_event, id: number, location: FlagsWindowLocation, marker: string) => {
    await flagsWindows.get(id)?.loadURL(await flagsWindowUrl(location, marker));
  });

  // Crash the window's renderer for real, then reload the same webContents once
  // render-process-gone has fired (the recovery pattern Electron documents).
  ipcMain.handle('crashFlagsWindow', (_event, id: number, marker: string) => {
    const wc = flagsWindows.get(id)?.webContents;
    if (!wc) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      wc.once('render-process-gone', (_goneEvent, details) => {
        setTimeout(() => {
          if (!wc.isDestroyed()) {
            void wc
              .loadURL(`${pathToFileURL(join(__dirname, 'main-window.html')).href}?${marker}`)
              .then(() => resolve(details.reason === 'crashed' || details.reason === 'killed'));
          }
        }, 500);
      });
      wc.forcefullyCrashRenderer();
    });
  });

  ipcMain.handle('flushTransport', async () => {
    await _flushTransport();
  });

  ipcMain.handle('setGlobalContext', (_event, context: Record<string, unknown>) => {
    setGlobalContext(context);
  });

  ipcMain.handle('setGlobalContextProperty', (_event, key: string, value: unknown) => {
    setGlobalContextProperty(key, value);
  });

  ipcMain.handle('removeGlobalContextProperty', (_event, key: string) => {
    removeGlobalContextProperty(key);
  });

  ipcMain.handle('clearGlobalContext', () => {
    clearGlobalContext();
  });

  ipcMain.handle('setUserInfo', (_event, user: UserInfo & { id: string }) => {
    setUserInfo(user);
  });

  ipcMain.handle('clearUserInfo', () => {
    clearUserInfo();
  });

  ipcMain.handle('addUserExtraInfo', (_event, extraInfo: Record<string, unknown>) => {
    addUserExtraInfo(extraInfo);
  });

  ipcMain.handle('setAccountInfo', (_event, accountInfo: AccountInfo) => {
    setAccountInfo(accountInfo);
  });

  ipcMain.handle('clearAccountInfo', () => {
    clearAccountInfo();
  });

  ipcMain.handle('addAccountExtraInfo', (_event, extraInfo: Record<string, unknown>) => {
    addAccountExtraInfo(extraInfo);
  });

  ipcMain.handle('ping', () => 'pong');

  ipcMain.handle('openRendererProcess', () => {
    testRendererWindow = new BrowserWindow({
      width: 400,
      height: 300,
      show: isDebugMode,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void testRendererWindow.loadFile(join(__dirname, 'main-window.html'));
    testRendererWindow.on('closed', () => {
      testRendererWindow = null;
    });
  });

  ipcMain.handle('closeRendererProcess', () => {
    testRendererWindow?.close();
    testRendererWindow = null;
  });

  // Simulates the app-driven crash recovery pattern Electron's own docs recommend: crash the
  // renderer, then reload the SAME webContents (it survives the process death) rather than closing
  // and recreating the window — so no 'web-contents-created' fires for the replacement renderer.
  // The reload is delayed slightly after 'render-process-gone': reloading in the same tick as the
  // crash races the OS tearing down the old process, which can take the whole webContents down with
  // it instead of respawning it — matching how a real app's own crash-recovery UI would only reload
  // once it has actually reacted to the crash, not synchronously within the same event loop turn.
  ipcMain.handle('crashAndReloadRendererProcess', () => {
    const wc = testRendererWindow?.webContents;
    if (!wc) return;
    wc.once('render-process-gone', () => {
      setTimeout(() => {
        // A query string (rather than wc.reload(), the same exact URL) makes the reloaded page's
        // execution_context.name distinguishable from the pre-crash one, without changing which
        // page/script actually runs.
        if (!wc.isDestroyed()) {
          void wc.loadURL(`${pathToFileURL(join(__dirname, 'main-window.html')).href}?revived=1`);
        }
      }, 500);
    });
    wc.forcefullyCrashRenderer();
  });

  ipcMain.on('mainFireAndForget', (event) => {
    event.sender.send('mainFireAndForgetAck');
  });

  ipcMain.handle('triggerMainSend', () => {
    mainWindow?.webContents.send('mainPush', 'hello');
  });

  ipcMain.handle('crash', () => {
    process.crash();
  });

  ipcMain.handle('openBridgeFileWindow', () => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: isDebugMode,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void win.loadFile(join(__dirname, 'bridge-window.html'));
  });

  ipcMain.handle('openBridgeFileWindowNoIsolation', () => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: isDebugMode,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: false,
      },
    });
    void win.loadFile(join(__dirname, 'bridge-window.html'));
  });

  ipcMain.handle('openBridgeHttpWindow', async () => {
    const port = await startRendererHttpServer();
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: isDebugMode,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void win.loadURL(`http://localhost:${port}`);
  });

  ipcMain.handle('openBridgeAppProtocolWindow', () => {
    serveBridgeWindowOverAppProtocol();
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: isDebugMode,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void win.loadURL('app://bridge/');
  });

  // In deferred-init mode the e2e opens the window itself via __ddE2E; don't auto-open at startup.
  if (process.env.DD_E2E_DEFER_INIT !== '1') {
    createWindow();
  }
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

  void mainWindow.loadFile(join(__dirname, 'main-window.html'));
}

/**
 * Provoke an SDK-internal error through a public API: `setAccountInfo` deep-clones its argument, so a
 * throwing getter surfaces as a monitored error and produces one error telemetry event.
 *
 * `discriminator` varies the message: telemetry deduplicates identical events per session, so without
 * it a burst collapses into a single event.
 */
function generateTelemetryError(discriminator: number) {
  setAccountInfo({
    id: 'telemetry-error',
    get name(): string {
      throw new Error(`expected error ${discriminator}`);
    },
  });
}

function getConfiguration(): InitConfiguration {
  if (process.env.DD_ELECTRON_SDK_CONFIG) {
    const config = JSON.parse(process.env.DD_ELECTRON_SDK_CONFIG) as InitConfiguration;
    if (process.env.DD_E2E_BEFORE_SEND_RUM === '1') {
      config.beforeSendRum = (event, context) => e2eControls.beforeSendRum(event, context);
    }
    return config;
  }
  throw new Error('DD_ELECTRON_SDK_CONFIG environment variable is not set');
}
