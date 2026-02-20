import { contextBridge, ipcRenderer } from 'electron';

// Expose IPC API to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  getSessionFile: () => ipcRenderer.invoke('get-session-file'),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  generateActivity: () => ipcRenderer.invoke('generate-activity'),
  generateTelemetryError: () => ipcRenderer.invoke('generateTelemetryError'),
  generateUncaughtException: () => ipcRenderer.invoke('generateUncaughtException'),
  generateUnhandledRejection: () => ipcRenderer.invoke('generateUnhandledRejection'),
});
