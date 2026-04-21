import { contextBridge, ipcRenderer } from 'electron';
import '@datadog/electron-sdk/preload';

contextBridge.exposeInMainWorld('electronAPI', {
  flushTransport: () => ipcRenderer.invoke('flushTransport'),
  crash: () => ipcRenderer.invoke('crash'),
});
