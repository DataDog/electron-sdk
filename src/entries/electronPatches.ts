import { createRequire } from 'node:module';
import { tracingChannel, channel } from 'node:diagnostics_channel';
import type { TracingChannel } from 'node:diagnostics_channel';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

function resolvePackage(id: string): string {
  return _require.resolve(id);
}

export function resolvePreloadPath(_resolvePackage = resolvePackage): string | undefined {
  try {
    return _resolvePackage('@datadog/electron-sdk/electron/preload');
  } catch {
    console.warn('[datadog] Could not resolve preload script — BrowserWindow injection skipped');
    return undefined;
  }
}

export function patchBrowserWindow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  electron: any,
  preloadPath: string
): void {
  const OriginalBrowserWindow = electron.BrowserWindow;

  class DatadogBrowserWindow extends OriginalBrowserWindow {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(options?: any) {
      // BrowserWindow doesn't support true subclassing (native code) — super()
      // returns the native instance, not `this`. Cast to any to access it.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
      const win = super(options ?? {}) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      win.webContents.session.registerPreloadScript({ type: 'frame', filePath: preloadPath });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return win;
    }
  }

  Object.assign(DatadogBrowserWindow, OriginalBrowserWindow);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  electron.BrowserWindow = DatadogBrowserWindow;
}

const mainReceiveCh = tracingChannel('apm:electron:ipc:main:receive');
const mainHandleCh = tracingChannel('apm:electron:ipc:main:handle');
export const mainSendCh = tracingChannel('apm:electron:ipc:main:send');
const rendererPatchedCh = channel('apm:electron:ipc:renderer:patched');
const rendererReceiveCh = tracingChannel('apm:electron:ipc:renderer:receive');
const rendererSendCh = tracingChannel('apm:electron:ipc:renderer:send');

interface IpcContext {
  args: unknown[];
  channel: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  self?: any;
  event?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

function wrapAddListener(
  ch: TracingChannel<IpcContext>,
  mappings: Record<string, WeakMap<AnyFn, AnyFn>>
): (addListener: AnyFn) => AnyFn {
  return (addListener) =>
    function (this: unknown, ipcChannel: string, listener: AnyFn) {
      const wrappedListener = (event: unknown, ...args: unknown[]) => {
        const ctx: IpcContext = { args, channel: ipcChannel, event };
        // tracePromise handles both sync and async listeners; Electron ignores return values from on/once
        return ch.tracePromise(() => listener.call(this, event, ...args) as Promise<unknown>, ctx);
      };
      const mapping = mappings[ipcChannel] ?? (mappings[ipcChannel] = new WeakMap());
      mapping.set(listener, wrappedListener);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return addListener.call(this, ipcChannel, wrappedListener);
    };
}

function wrapRemoveListener(mappings: Record<string, WeakMap<AnyFn, AnyFn>>): (remove: AnyFn) => AnyFn {
  return (removeListener) =>
    function (this: unknown, ipcChannel: string, listener: AnyFn) {
      const wrapper = mappings[ipcChannel]?.get(listener);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return removeListener.call(this, ipcChannel, wrapper ?? listener);
    };
}

function wrapRemoveHandler(mappings: Record<string, WeakMap<AnyFn, AnyFn>>): (remove: AnyFn) => AnyFn {
  return (removeHandler) =>
    function (this: unknown, ipcChannel: string) {
      delete mappings[ipcChannel];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return removeHandler.call(this, ipcChannel);
    };
}

function wrapRemoveAllListeners(mappings: Record<string, WeakMap<AnyFn, AnyFn>>): (remove: AnyFn) => AnyFn {
  return (removeAllListeners) =>
    function (this: unknown, ipcChannel?: string) {
      if (ipcChannel) {
        delete mappings[ipcChannel];
      } else {
        for (const key of Object.keys(mappings)) delete mappings[key];
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return removeAllListeners.call(this, ipcChannel);
    };
}

function wrapSend(ch: TracingChannel<IpcContext>, promise = false): (send: AnyFn) => AnyFn {
  const trace = promise ? ch.tracePromise.bind(ch) : ch.traceSync.bind(ch);
  return (send) =>
    function (this: unknown, ipcChannel: string, ...args: unknown[]) {
      const ctx: IpcContext = { args, channel: ipcChannel, self: this };
      return trace(() => send.call(this, ipcChannel, ...ctx.args) as Promise<unknown>, ctx);
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrap(obj: any, method: string, wrapper: (original: AnyFn) => AnyFn): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  obj[method] = wrapper((obj[method] as AnyFn).bind(obj));
}

export function patchIpcMain(ipcMain: Electron.IpcMain): void {
  const listeners: Record<string, WeakMap<AnyFn, AnyFn>> = {};
  const handlers: Record<string, WeakMap<AnyFn, AnyFn>> = {};

  wrap(ipcMain, 'addListener', wrapAddListener(mainReceiveCh, listeners));
  wrap(ipcMain, 'handle', wrapAddListener(mainHandleCh, handlers));
  wrap(ipcMain, 'handleOnce', wrapAddListener(mainHandleCh, handlers));
  wrap(ipcMain, 'off', wrapRemoveListener(listeners));
  wrap(ipcMain, 'on', wrapAddListener(mainReceiveCh, listeners));
  wrap(ipcMain, 'once', wrapAddListener(mainReceiveCh, listeners));
  wrap(ipcMain, 'removeAllListeners', wrapRemoveAllListeners(listeners));
  wrap(ipcMain, 'removeHandler', wrapRemoveHandler(handlers));
  wrap(ipcMain, 'removeListener', wrapRemoveListener(listeners));

  ipcMain.once('datadog:apm:renderer:patched', (event) => rendererPatchedCh.publish(event));
}

export function patchIpcRenderer(ipcRenderer: Electron.IpcRenderer): void {
  const listeners: Record<string, WeakMap<AnyFn, AnyFn>> = {};

  wrap(ipcRenderer, 'invoke', wrapSend(rendererSendCh, true));
  wrap(ipcRenderer, 'send', wrapSend(rendererSendCh));
  wrap(ipcRenderer, 'sendSync', wrapSend(rendererSendCh));
  wrap(ipcRenderer, 'sendToHost', wrapSend(rendererSendCh));
  wrap(ipcRenderer, 'addListener', wrapAddListener(rendererReceiveCh, listeners));
  wrap(ipcRenderer, 'off', wrapRemoveListener(listeners));
  wrap(ipcRenderer, 'on', wrapAddListener(rendererReceiveCh, listeners));
  wrap(ipcRenderer, 'once', wrapAddListener(rendererReceiveCh, listeners));
  wrap(ipcRenderer, 'removeListener', wrapRemoveListener(listeners));
  wrap(ipcRenderer, 'removeAllListeners', wrapRemoveAllListeners(listeners));

  ipcRenderer.send('datadog:apm:renderer:patched');
}
