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
  mainNetFetch: (url: string) => ipcRenderer.invoke('mainNetFetch', url),
  flushTransport: () => ipcRenderer.invoke('flushTransport'),
  crash: () => ipcRenderer.invoke('crash'),
  ping: () => ipcRenderer.invoke('ping'),
  openBridgeFileWindow: () => ipcRenderer.invoke('openBridgeFileWindow'),
  openBridgeFileWindowNoIsolation: () => ipcRenderer.invoke('openBridgeFileWindowNoIsolation'),
  openBridgeHttpWindow: () => ipcRenderer.invoke('openBridgeHttpWindow'),
});
