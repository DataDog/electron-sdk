import { contextBridge, ipcRenderer } from 'electron';

// Expose IPC API to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  getSessionFile: () => ipcRenderer.invoke('get-session-file'),
  clearSessionFile: () => ipcRenderer.invoke('clear-session-file'),
  generateTelemetryError: () => ipcRenderer.invoke('generateTelemetryError'),
});
