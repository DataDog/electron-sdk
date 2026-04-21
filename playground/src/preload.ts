import { contextBridge, ipcRenderer } from 'electron';

// Expose IPC API to renderer process
// ipcRenderer is automatically instrumented by the SDK via session.registerPreloadScript()
contextBridge.exposeInMainWorld('electronAPI', {
  getSessionFile: () => ipcRenderer.invoke('get-session-file'),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  generateTelemetryError: () => ipcRenderer.invoke('generateTelemetryError'),
  generateUncaughtException: () => ipcRenderer.invoke('generateUncaughtException'),
  generateUnhandledRejection: () => ipcRenderer.invoke('generateUnhandledRejection'),
  crash: () => ipcRenderer.invoke('crash'),
  mainFetchApi: () => ipcRenderer.invoke('main:fetch-api'),
  openRumExplorer: () => ipcRenderer.invoke('open-rum-explorer'),
  flushTransport: () => ipcRenderer.invoke('flush-transport'),
});
