import { contextBridge, ipcRenderer } from 'electron';

// No need to import '@datadog/electron-sdk/preload' here — the SDK is loaded from
// node_modules (not bundled), so it auto-registers preload-auto.cjs as a session
// preload via session.defaultSession.registerPreloadScript() during init().
contextBridge.exposeInMainWorld('electronAPI', {
  flushTransport: () => ipcRenderer.invoke('flushTransport'),
  crash: () => ipcRenderer.invoke('crash'),
});
