import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as childProcess from 'node:child_process';
import { init, stopSession, _generateActivity, _generateTelemetryError, _flushTransport } from '@datadog/electron-sdk';
import { loadWindowState, saveWindowState } from './main/windowState';
import { setupHotReload } from './main/hotReload';

const isTestMode = process.env.DD_TEST_MODE === '1';
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

ipcMain.handle('flushTransport', async () => {
  await _flushTransport();
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

// --- Child process demo handlers ---

ipcMain.handle('child-process:spawn-ls', () => {
  return new Promise<string>((resolve, reject) => {
    const child = childProcess.spawn('ls', ['-la']);
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.on('close', () => resolve(stdout));
    child.on('error', reject);
  });
});

ipcMain.handle('child-process:exec-echo', () => {
  return new Promise<string>((resolve, reject) => {
    childProcess.exec('echo hello world', (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
});

ipcMain.handle('child-process:spawn-fail', () => {
  return new Promise<string>((resolve) => {
    const child = childProcess.spawn('nonexistent-command-xyz');
    child.on('error', (err) => resolve(`Error: ${err.message}`));
    child.on('close', (code) => resolve(`Exited with code ${code}`));
  });
});

ipcMain.handle('child-process:exec-timeout', () => {
  return new Promise<string>((resolve) => {
    childProcess.exec('sleep 10', { timeout: 100 }, (error) => {
      resolve(error ? `Timeout: ${error.message}` : 'Completed');
    });
  });
});

// --- Utility process demo handlers ---

const WORKER_PATH = path.join(__dirname, 'workers', 'demo-worker.js');

ipcMain.handle('utility-process:fork', () => {
  return new Promise<string>((resolve) => {
    const child = utilityProcess.fork(WORKER_PATH, [], { serviceName: 'dd-demo-worker' });
    child.once('message', (msg: { ready?: boolean }) => {
      if (msg.ready) resolve(`Worker forked, pid: ${child.pid}`);
    });
    child.once('exit', (code: number) => resolve(`Worker exited with code ${code}`));
  });
});

ipcMain.handle('utility-process:send-message', () => {
  return new Promise<string>((resolve) => {
    const child = utilityProcess.fork(WORKER_PATH, [], { serviceName: 'dd-demo-worker' });
    child.once('message', (msg: { ready?: boolean; reply?: string }) => {
      if (msg.ready) {
        child.postMessage({ action: 'ping' });
      } else if (msg.reply) {
        resolve(`Reply: ${msg.reply}`);
        child.kill();
      }
    });
    child.once('exit', () => resolve('Worker exited'));
  });
});

ipcMain.handle('utility-process:crash', () => {
  return new Promise<string>((resolve) => {
    const child = utilityProcess.fork(WORKER_PATH, [], { serviceName: 'dd-demo-crash-worker' });
    child.once('message', (msg: { ready?: boolean }) => {
      if (msg.ready) {
        child.postMessage({ action: 'crash' });
      }
    });
    child.once('exit', (code: number) => resolve(`Worker crashed, exit code: ${code}`));
  });
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
      applicationId: '0f574f27-317e-4223-b5b6-c935b4c83700',
      clientToken: 'pub09a54e493460355ef58c0c617d577e19',
      site: 'datadoghq.com',
    },
  };
  const result = await init({
    ...CONF.staging,
    service: 'electron-playground',
    env: 'dev',
    // Allow tests to redirect events to a mock intake server
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
