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
  setUserInfo: () => ipcRenderer.invoke('main:set-user-info'),
  setUserInfoProperty: () => ipcRenderer.invoke('main:set-user-info-property'),
  clearUserInfo: () => ipcRenderer.invoke('main:clear-user-info'),
  setAccountInfo: () => ipcRenderer.invoke('main:set-account-info'),
  setAccountInfoProperty: () => ipcRenderer.invoke('main:set-account-info-property'),
  clearAccountInfo: () => ipcRenderer.invoke('main:clear-account-info'),
});
