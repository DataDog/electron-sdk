import { contextBridge, ipcRenderer } from 'electron';

// Expose IPC API to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  getSessionFile: () => ipcRenderer.invoke('get-session-file'),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  generateTelemetryError: () => ipcRenderer.invoke('generateTelemetryError'),
  generateUncaughtException: () => ipcRenderer.invoke('generateUncaughtException'),
  generateUnhandledRejection: () => ipcRenderer.invoke('generateUnhandledRejection'),
  crash: () => ipcRenderer.invoke('crash'),
  mainFetchApi: () => ipcRenderer.invoke('main:fetch-api'),
  mainFetchApiFetch: () => ipcRenderer.invoke('main:fetch-api-fetch'),
  mainFetchApiNet: () => ipcRenderer.invoke('main:fetch-api-net'),
});
