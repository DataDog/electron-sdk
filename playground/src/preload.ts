import { contextBridge, ipcRenderer } from 'electron';

// Expose IPC API to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  initSDK: () => ipcRenderer.invoke('init-sdk'),
});
