import { contextBridge, ipcRenderer } from 'electron';

const rumBrowserSdkConfig = process.env.DD_RUM_BROWSER_SDK
  ? (JSON.parse(process.env.DD_RUM_BROWSER_SDK) as Record<string, unknown>)
  : null;
contextBridge.exposeInMainWorld('e2eConfig', { rumBrowserSdk: rumBrowserSdkConfig });

// Feature flags probe: counts snapshot pushes this document receives, independently of the SDK.
let flagsUpdateCount = 0;
ipcRenderer.on('datadog:flags-update', () => {
  flagsUpdateCount += 1;
});

contextBridge.exposeInMainWorld('electronAPI', {
  // Calls the flags snapshot channel directly, the way a page with IPC access could.
  invokeFlagsSnapshot: () => ipcRenderer.invoke('datadog:flags-snapshot') as Promise<string | undefined>,
  getFlagsUpdateCount: () => flagsUpdateCount,
  openFlagsWindow: (options: { partition?: string; location?: string; marker: string }) =>
    ipcRenderer.invoke('openFlagsWindow', options),
  navigateFlagsWindow: (id: number, location: string, marker: string) =>
    ipcRenderer.invoke('navigateFlagsWindow', id, location, marker),
  crashFlagsWindow: (id: number, marker: string) => ipcRenderer.invoke('crashFlagsWindow', id, marker),
  evaluateInFlagsWindow: (id: number, flagKey: string) => ipcRenderer.invoke('evaluateInFlagsWindow', id, flagKey),
  generateTelemetryErrors: (count: number) => ipcRenderer.invoke('generateTelemetryErrors', count),
  stopSession: () => ipcRenderer.invoke('stopSession'),
  getSessionId: () => ipcRenderer.invoke('getSessionId'),
  generateUncaughtException: () => ipcRenderer.invoke('generateUncaughtException'),
  generateUnhandledRejection: () => ipcRenderer.invoke('generateUnhandledRejection'),
  generateManualError: (startTime?: number, context?: Record<string, string>) =>
    ipcRenderer.invoke('generateManualError', startTime, context),
  addDurationVital: (name: string, options: Record<string, unknown>) =>
    ipcRenderer.invoke('addDurationVital', name, options),
  startDurationVital: (name: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke('startDurationVital', name, options),
  stopDurationVital: (name: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke('stopDurationVital', name, options),
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
  mainFireAndForget: () =>
    new Promise<void>((resolve) => {
      ipcRenderer.once('mainFireAndForgetAck', () => resolve());
      ipcRenderer.send('mainFireAndForget');
    }),
  triggerMainSend: () =>
    new Promise<void>((resolve) => {
      ipcRenderer.once('mainPush', () => resolve());
      void ipcRenderer.invoke('triggerMainSend');
    }),
  registerFlagsProvider: (context?: Record<string, unknown>) => ipcRenderer.invoke('registerFlagsProvider', context),
  setFlagsContext: (context: Record<string, unknown>) => ipcRenderer.invoke('setFlagsContext', context),
  evaluateFlag: (type: 'boolean' | 'string', flagKey: string, defaultValue: unknown) =>
    ipcRenderer.invoke('evaluateFlag', type, flagKey, defaultValue),
  getFlagsProviderStatus: () => ipcRenderer.invoke('getFlagsProviderStatus'),
  flushTransport: () => ipcRenderer.invoke('flushTransport'),
  setGlobalContext: (context: Record<string, unknown>) => ipcRenderer.invoke('setGlobalContext', context),
  setGlobalContextProperty: (key: string, value: unknown) => ipcRenderer.invoke('setGlobalContextProperty', key, value),
  removeGlobalContextProperty: (key: string) => ipcRenderer.invoke('removeGlobalContextProperty', key),
  clearGlobalContext: () => ipcRenderer.invoke('clearGlobalContext'),
  setUserInfo: (user: Record<string, unknown>) => ipcRenderer.invoke('setUserInfo', user),
  clearUserInfo: () => ipcRenderer.invoke('clearUserInfo'),
  addUserExtraInfo: (extraInfo: Record<string, unknown>) => ipcRenderer.invoke('addUserExtraInfo', extraInfo),
  setAccountInfo: (accountInfo: Record<string, unknown>) => ipcRenderer.invoke('setAccountInfo', accountInfo),
  clearAccountInfo: () => ipcRenderer.invoke('clearAccountInfo'),
  addAccountExtraInfo: (extraInfo: Record<string, unknown>) => ipcRenderer.invoke('addAccountExtraInfo', extraInfo),
  crash: () => ipcRenderer.invoke('crash'),
  ping: () => ipcRenderer.invoke('ping'),
  openBridgeFileWindow: () => ipcRenderer.invoke('openBridgeFileWindow'),
  openBridgeFileWindowNoIsolation: () => ipcRenderer.invoke('openBridgeFileWindowNoIsolation'),
  openBridgeHttpWindow: () => ipcRenderer.invoke('openBridgeHttpWindow'),
  openBridgeAppProtocolWindow: () => ipcRenderer.invoke('openBridgeAppProtocolWindow'),
  openRendererProcess: () => ipcRenderer.invoke('openRendererProcess'),
  closeRendererProcess: () => ipcRenderer.invoke('closeRendererProcess'),
  crashAndReloadRendererProcess: () => ipcRenderer.invoke('crashAndReloadRendererProcess'),
});
