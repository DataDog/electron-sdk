import { contextBridge, ipcRenderer } from 'electron';

// Expose IPC API to renderer process
// ipcRenderer is automatically instrumented by the SDK via session.registerPreloadScript()
contextBridge.exposeInMainWorld('electronAPI', {
  getSessionFile: () => ipcRenderer.invoke('get-session-file'),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  generateActivity: () => ipcRenderer.invoke('generate-activity'),
  generateTelemetryError: () => ipcRenderer.invoke('generateTelemetryError'),
  generateUncaughtException: () => ipcRenderer.invoke('generateUncaughtException'),
  generateUnhandledRejection: () => ipcRenderer.invoke('generateUnhandledRejection'),
  crash: () => ipcRenderer.invoke('crash'),
  mainFetchApi: () => ipcRenderer.invoke('main:fetch-api'),
  flushTransport: () => ipcRenderer.invoke('flushTransport'),
  spawnLs: () => ipcRenderer.invoke('child-process:spawn-ls'),
  execEcho: () => ipcRenderer.invoke('child-process:exec-echo'),
  spawnFail: () => ipcRenderer.invoke('child-process:spawn-fail'),
  execTimeout: () => ipcRenderer.invoke('child-process:exec-timeout'),
  forkUtility: () => ipcRenderer.invoke('utility-process:fork'),
  sendMessage: () => ipcRenderer.invoke('utility-process:send-message'),
  crashUtility: () => ipcRenderer.invoke('utility-process:crash'),
});
