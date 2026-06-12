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
  setUser: () => ipcRenderer.invoke('main:set-user'),
  addUserExtra: () => ipcRenderer.invoke('main:add-user-extra'),
  clearUser: () => ipcRenderer.invoke('main:clear-user'),
  setAccount: () => ipcRenderer.invoke('main:set-account'),
  addAccountExtra: () => ipcRenderer.invoke('main:add-account-extra'),
  clearAccount: () => ipcRenderer.invoke('main:clear-account'),
});
