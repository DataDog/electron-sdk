import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  initSDK: () => ipcRenderer.invoke('init-sdk'),
});
