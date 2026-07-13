import { contextBridge, ipcRenderer } from 'electron';

// Expose IPC API to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  getInternalContext: () => ipcRenderer.invoke('get-internal-context'),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  generateTelemetryError: () => ipcRenderer.invoke('generateTelemetryError'),
  generateUncaughtException: () => ipcRenderer.invoke('generateUncaughtException'),
  generateUnhandledRejection: () => ipcRenderer.invoke('generateUnhandledRejection'),
  crash: () => ipcRenderer.invoke('crash'),
  mainFetchApi: () => ipcRenderer.invoke('main:fetch-api'),
  addDurationVital: (
    name: string,
    options: {
      startTime: number;
      duration: number;
      vitalKey?: string;
      context?: Record<string, unknown>;
      description?: string;
    }
  ) => ipcRenderer.invoke('main:add-duration-vital', name, options),
  startDurationVital: (
    name: string,
    options?: { vitalKey?: string; context?: Record<string, unknown>; description?: string }
  ) => ipcRenderer.invoke('main:start-duration-vital', name, options),
  stopDurationVital: (
    name: string,
    options?: { vitalKey?: string; context?: Record<string, unknown>; description?: string }
  ) => ipcRenderer.invoke('main:stop-duration-vital', name, options),
  startOperation: (name: string, options?: { operationKey?: string }) =>
    ipcRenderer.invoke('main:start-operation', name, options),
  succeedOperation: (name: string, options?: { operationKey?: string }) =>
    ipcRenderer.invoke('main:succeed-operation', name, options),
  failOperation: (name: string, failureReason: 'error' | 'abandoned' | 'other', options?: { operationKey?: string }) =>
    ipcRenderer.invoke('main:fail-operation', name, failureReason, options),
  mainFetchApiFetch: () => ipcRenderer.invoke('main:fetch-api-fetch'),
  mainFetchApiNet: () => ipcRenderer.invoke('main:fetch-api-net'),
  openRumExplorer: () => ipcRenderer.invoke('open-rum-explorer'),
  flushTransport: () => ipcRenderer.invoke('flush-transport'),
});
