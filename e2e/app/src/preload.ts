import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  generateTelemetryError: () => ipcRenderer.invoke('generateTelemetryError'),
});
