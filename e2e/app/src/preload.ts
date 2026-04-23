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
  startFeatureOperation: (name: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke('startFeatureOperation', name, options),
  succeedFeatureOperation: (name: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke('succeedFeatureOperation', name, options),
  failFeatureOperation: (name: string, failureReason: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke('failFeatureOperation', name, failureReason, options),
  flushTransport: () => ipcRenderer.invoke('flushTransport'),
  crash: () => ipcRenderer.invoke('crash'),
  openBridgeFileWindow: () => ipcRenderer.invoke('openBridgeFileWindow'),
  openBridgeFileWindowNoIsolation: () => ipcRenderer.invoke('openBridgeFileWindowNoIsolation'),
  openBridgeHttpWindow: () => ipcRenderer.invoke('openBridgeHttpWindow'),
});
