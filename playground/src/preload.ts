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
  startOperation: (name: string, options?: { operationKey?: string }) =>
    ipcRenderer.invoke('main:start-operation', name, options),
  succeedOperation: (name: string, options?: { operationKey?: string }) =>
    ipcRenderer.invoke('main:succeed-operation', name, options),
  failOperation: (name: string, failureReason: 'error' | 'abandoned' | 'other', options?: { operationKey?: string }) =>
    ipcRenderer.invoke('main:fail-operation', name, failureReason, options),
  mainFetchApiFetch: () => ipcRenderer.invoke('main:fetch-api-fetch'),
  mainFetchApiNet: () => ipcRenderer.invoke('main:fetch-api-net'),
  flushTransport: () => ipcRenderer.invoke('flush-transport'),
  demoGetData: () => ipcRenderer.invoke('demo:get-data'),
  demoTriggerPush: () => ipcRenderer.invoke('demo:trigger-push'),
  onPushNotification: (cb: (data: unknown) => void) =>
    ipcRenderer.on('demo:push-notification', (_event, data) => cb(data as unknown)),
});
