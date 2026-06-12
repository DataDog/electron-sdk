import { contextBridge, ipcRenderer } from 'electron';

const rumBrowserSdkConfig = process.env.DD_RUM_BROWSER_SDK
  ? (JSON.parse(process.env.DD_RUM_BROWSER_SDK) as Record<string, unknown>)
  : null;
contextBridge.exposeInMainWorld('e2eConfig', { rumBrowserSdk: rumBrowserSdkConfig });

contextBridge.exposeInMainWorld('electronAPI', {
  generateTelemetryErrors: (count: number) => ipcRenderer.invoke('generateTelemetryErrors', count),
  stopSession: () => ipcRenderer.invoke('stopSession'),
  generateUncaughtException: () => ipcRenderer.invoke('generateUncaughtException'),
  generateUnhandledRejection: () => ipcRenderer.invoke('generateUnhandledRejection'),
  generateManualError: (startTime?: number) => ipcRenderer.invoke('generateManualError', startTime),
  startOperation: (name: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke('startOperation', name, options),
  succeedOperation: (name: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke('succeedOperation', name, options),
  failOperation: (name: string, failureReason: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke('failOperation', name, failureReason, options),
  mainFetch: (url: string) => ipcRenderer.invoke('mainFetch', url),
  mainHttpRequest: (url: string) => ipcRenderer.invoke('mainHttpRequest', url),
  mainNetRequest: (url: string) => ipcRenderer.invoke('mainNetRequest', url),
  flushTransport: () => ipcRenderer.invoke('flushTransport'),
  setUserInfo: (user: Record<string, unknown>) => ipcRenderer.invoke('setUserInfo', user),
  clearUserInfo: () => ipcRenderer.invoke('clearUserInfo'),
  setUserInfoProperty: (key: string, value: unknown) => ipcRenderer.invoke('setUserInfoProperty', key, value),
  removeUserInfoProperty: (key: string) => ipcRenderer.invoke('removeUserInfoProperty', key),
  setAccountInfo: (accountInfo: Record<string, unknown>) => ipcRenderer.invoke('setAccountInfo', accountInfo),
  clearAccountInfo: () => ipcRenderer.invoke('clearAccountInfo'),
  setAccountInfoProperty: (key: string, value: unknown) => ipcRenderer.invoke('setAccountInfoProperty', key, value),
  removeAccountInfoProperty: (key: string) => ipcRenderer.invoke('removeAccountInfoProperty', key),
  crash: () => ipcRenderer.invoke('crash'),
  ping: () => ipcRenderer.invoke('ping'),
  openBridgeFileWindow: () => ipcRenderer.invoke('openBridgeFileWindow'),
  openBridgeFileWindowNoIsolation: () => ipcRenderer.invoke('openBridgeFileWindowNoIsolation'),
  openBridgeHttpWindow: () => ipcRenderer.invoke('openBridgeHttpWindow'),
});
