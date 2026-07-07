import '@datadog/electron-sdk/instrument';
import { app, BrowserWindow, ipcMain, net } from 'electron';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  init,
  addError,
  addAction,
  _generateTelemetryError,
  _flushTransport,
  stopSession,
  startOperation,
  succeedOperation,
  failOperation,
  type FailureReason,
  type FeatureOperationOptions,
  type InitConfiguration,
} from '@datadog/electron-sdk';

const isDebugMode = process.env.PWDEBUG === '1';
let mainWindow: BrowserWindow | null = null;
let rendererHttpServer: http.Server | null = null;

const noop = () => undefined;

function startRendererHttpServer(): Promise<number> {
  return new Promise((resolve) => {
    rendererHttpServer = http.createServer((_req, res) => {
      const htmlPath = join(__dirname, 'bridge-window.html');
      const jsPath = join(__dirname, 'bridge-window.js');

      if (_req.url === '/' || _req.url?.endsWith('.html')) {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
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

  ipcMain.handle('addAction', (_event, name: string, context?: Record<string, unknown>) => {
    // IPC carries arbitrary JSON; cast to the SDK's Context at the call boundary.
    addAction(name, context as Parameters<typeof addAction>[1]);
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

  ipcMain.handle('flushTransport', async () => {
    await _flushTransport();
  });

  ipcMain.handle('ping', () => 'pong');

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

function getConfiguration(): InitConfiguration {
  if (process.env.DD_ELECTRON_SDK_CONFIG) {
    return JSON.parse(process.env.DD_ELECTRON_SDK_CONFIG) as InitConfiguration;
  }
  throw new Error('DD_ELECTRON_SDK_CONFIG environment variable is not set');
}
