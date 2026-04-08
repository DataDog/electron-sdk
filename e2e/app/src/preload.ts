import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  generateTelemetryErrors: (count: number) => ipcRenderer.invoke('generateTelemetryErrors', count),
  stopSession: () => ipcRenderer.invoke('stopSession'),
  generateUncaughtException: () => ipcRenderer.invoke('generateUncaughtException'),
  generateUnhandledRejection: () => ipcRenderer.invoke('generateUnhandledRejection'),
  generateManualError: (startTime?: number) => ipcRenderer.invoke('generateManualError', startTime),
  flushTransport: () => ipcRenderer.invoke('flushTransport'),
  crash: () => ipcRenderer.invoke('crash'),
  openBridgeFileWindow: () => ipcRenderer.invoke('openBridgeFileWindow'),
  openBridgeFileWindowNoIsolation: () => ipcRenderer.invoke('openBridgeFileWindowNoIsolation'),
  openBridgeHttpWindow: () => ipcRenderer.invoke('openBridgeHttpWindow'),
});
