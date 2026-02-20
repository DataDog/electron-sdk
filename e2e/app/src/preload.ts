import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  generateTelemetryErrors: (count: number) => ipcRenderer.invoke('generateTelemetryErrors', count),
  stopSession: () => ipcRenderer.invoke('stopSession'),
  generateActivity: () => ipcRenderer.invoke('generateActivity'),
  generateUncaughtException: () => ipcRenderer.invoke('generateUncaughtException'),
  generateUnhandledRejection: () => ipcRenderer.invoke('generateUnhandledRejection'),
});
