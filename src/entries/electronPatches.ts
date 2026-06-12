import ddTrace from 'dd-trace';
import { createRequire } from 'node:module';

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

export function patchBrowserWindow(electron: typeof import('electron'), preloadPath: string): void {
  const OriginalBrowserWindow = electron.BrowserWindow;

  class DatadogBrowserWindow extends OriginalBrowserWindow {
    constructor(options?: Electron.BrowserWindowConstructorOptions) {
      // BrowserWindow doesn't support true subclassing (native code) — super()
      // returns the native instance, not `this`. Cast to any to access it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const win = super(options ?? {}) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      win.webContents.session.registerPreloadScript({ type: 'frame', filePath: preloadPath });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return win;
    }
  }

  Object.assign(DatadogBrowserWindow, OriginalBrowserWindow);
  (electron as { BrowserWindow: unknown }).BrowserWindow = DatadogBrowserWindow;
}

type IpcEvent = Electron.IpcMainEvent | Electron.IpcMainInvokeEvent | Electron.IpcRendererEvent;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function wrapAddListener(
  spanName: string,
  mappings: Record<string, WeakMap<AnyFn, AnyFn>>
): (addListener: AnyFn) => AnyFn {
  return (addListener) =>
    function (this: unknown, ipcChannel: string, listener: AnyFn) {
      const wrappedListener = (event: IpcEvent, ...args: unknown[]) => {
        if (ipcChannel.startsWith('datadog:')) {
          return listener.call(this, event, ...args) as unknown;
        }

        const lastArg = args[args.length - 1];
        const childOf =
          lastArg !== null && typeof lastArg === 'object'
            ? ddTrace.extract('text_map', lastArg as Record<string, string>)
            : null;
        const callArgs = childOf ? args.slice(0, -1) : args;

        const span = ddTrace.startSpan(spanName, {
          childOf: childOf ?? undefined,
          tags: {
            'span.kind': 'consumer',
            component: 'electron',
            'resource.name': ipcChannel,
            type: 'worker',
          },
        });

        return ddTrace.scope().activate(span, () => {
          let result: unknown;
          try {
            result = listener.call(this, event, ...callArgs) as unknown;
          } catch (err) {
            span.setTag('error', err);
            span.finish();
            throw err;
          }

          if (isPromise(result)) {
            void result.then(
              () => span.finish(),
              (err: unknown) => {
                span.setTag('error', err);
                span.finish();
              }
            );
            return result;
          }

          span.finish();
          return result;
        });
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

function wrapSend(spanName: string, promise = false): (send: AnyFn) => AnyFn {
  return (send) =>
    function (this: unknown, ipcChannel: string, ...args: unknown[]) {
      if (ipcChannel.startsWith('datadog:')) {
        return send.call(this, ipcChannel, ...args) as unknown;
      }

      const span = ddTrace.startSpan(spanName, {
        tags: {
          'span.kind': 'producer',
          component: 'electron',
          'resource.name': ipcChannel,
        },
      });

      return ddTrace.scope().activate(span, () => {
        const carrier: Record<string, string> = {};
        ddTrace.inject(span, 'text_map', carrier);

        let result: unknown;
        try {
          result = send.call(this, ipcChannel, ...args, carrier) as unknown;
        } catch (err) {
          span.setTag('error', err);
          span.finish();
          throw err;
        }

        if (promise && isPromise(result)) {
          void result.then(
            () => span.finish(),
            (err: unknown) => {
              span.setTag('error', err);
              span.finish();
            }
          );
          return result;
        }

        span.finish();
        return result;
      });
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

  wrap(ipcMain, 'addListener', wrapAddListener('electron.main.receive', listeners));
  wrap(ipcMain, 'handle', wrapAddListener('electron.main.handle', handlers));
  wrap(ipcMain, 'handleOnce', wrapAddListener('electron.main.handle', handlers));
  wrap(ipcMain, 'off', wrapRemoveListener(listeners));
  wrap(ipcMain, 'on', wrapAddListener('electron.main.receive', listeners));
  wrap(ipcMain, 'once', wrapAddListener('electron.main.receive', listeners));
  wrap(ipcMain, 'removeAllListeners', wrapRemoveAllListeners(listeners));
  wrap(ipcMain, 'removeHandler', wrapRemoveHandler(handlers));
  wrap(ipcMain, 'removeListener', wrapRemoveListener(listeners));
}

export function patchIpcRenderer(ipcRenderer: Electron.IpcRenderer): void {
  const listeners: Record<string, WeakMap<AnyFn, AnyFn>> = {};

  wrap(ipcRenderer, 'invoke', wrapSend('electron.renderer.send', true));
  wrap(ipcRenderer, 'send', wrapSend('electron.renderer.send'));
  wrap(ipcRenderer, 'sendSync', wrapSend('electron.renderer.send'));
  wrap(ipcRenderer, 'sendToHost', wrapSend('electron.renderer.send'));
  wrap(ipcRenderer, 'addListener', wrapAddListener('electron.renderer.receive', listeners));
  wrap(ipcRenderer, 'off', wrapRemoveListener(listeners));
  wrap(ipcRenderer, 'on', wrapAddListener('electron.renderer.receive', listeners));
  wrap(ipcRenderer, 'once', wrapAddListener('electron.renderer.receive', listeners));
  wrap(ipcRenderer, 'removeListener', wrapRemoveListener(listeners));
  wrap(ipcRenderer, 'removeAllListeners', wrapRemoveAllListeners(listeners));
}

export function patchNet(net: Electron.Net): void {
  const originalRequest = net.request.bind(net);

  (net as { request: unknown }).request = function (
    options: Electron.ClientRequestConstructorOptions | string
  ): Electron.ClientRequest {
    const opts: Electron.ClientRequestConstructorOptions =
      typeof options === 'string' ? { url: options } : { ...options };

    let parsed: URL | undefined;
    try {
      if (opts.url) parsed = new URL(opts.url);
    } catch {
      // invalid URL
    }

    const method = (opts.method ?? 'GET').toUpperCase();
    const urlStr = opts.url ?? parsed?.href ?? '';

    const span = ddTrace.startSpan('http.request', {
      tags: {
        'span.kind': 'client',
        'span.type': 'http',
        component: 'electron',
        'resource.name': method,
        'http.method': method,
        'http.url': urlStr,
      },
    });

    const carrier: Record<string, string> = {};
    ddTrace.inject(span, 'http_headers', carrier);
    const existingHeaders = opts.headers ?? {};
    opts.headers = { ...carrier, ...existingHeaders };

    const req = originalRequest(opts);

    let finished = false;
    const finish = (err?: unknown): void => {
      if (finished) return;
      finished = true;
      if (err !== undefined) span.setTag('error', err);
      span.finish();
    };

    req.on('response', (response: Electron.IncomingMessage) => {
      span.setTag('http.status_code', String(response.statusCode));
      response.on('end', () => finish());
      response.on('error', (err: unknown) => finish(err));
    });
    req.on('error', (err: Error) => finish(err));
    req.on('abort', () => finish());

    return req;
  } as typeof net.request;
}
