import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  flushTransport: () => ipcRenderer.invoke('flushTransport'),
  crash: () => ipcRenderer.invoke('crash'),
  mainFetch: (url: string) => ipcRenderer.invoke('mainFetch', url),
  openCustomSessionWindow: () => ipcRenderer.invoke('openCustomSessionWindow'),
});
