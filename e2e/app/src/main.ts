import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { init, type InitConfiguration } from '@datadog/electron-sdk';

let mainWindow: BrowserWindow | null = null;

void app.whenReady().then(() => {
  const config = getConfiguration();
  console.log('Initializing SDK with config:', config);
  const initialized = init(config);
  console.log('SDK initialized:', initialized);
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
