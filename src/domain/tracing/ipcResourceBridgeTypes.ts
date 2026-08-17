/**
 * Shared, side-effect-free types for the renderer-side IPC resource bridge.
 *
 * Split out from `src/preload/ipc.ts` so `src/renderer/wireIpcResourceBridge.ts` (which runs in the
 * main world, not the preload context) can reference the same event shape without importing
 * `src/preload/ipc.ts` itself — that module imports `electron`'s `contextBridge`/`ipcRenderer` at the
 * top level and calls `contextBridge.exposeInMainWorld` as a side effect on import, neither of which
 * is available or safe to run in a contextIsolated renderer's main-world bundle.
 */
export interface ResourceHandlerEvent {
  action: 'start' | 'stop';
  url: string;
  options?: Record<string, unknown>;
}

export type ResourceHandler = (event: ResourceHandlerEvent) => void;
