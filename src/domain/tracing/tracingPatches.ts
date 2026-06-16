import { createRequire } from 'node:module';

// Support both CJS (__filename) and ESM (import.meta.url) contexts
const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

/**
 * dd-trace's electron instrumentation wraps ipcMain.handle with TracingChannel.tracePromise,
 * which uses channel.runStores (enterWith/restore) to propagate the handle span via
 * AsyncLocalStorage. However, Electron's native IPC and net stack doesn't reliably propagate
 * Node.js AsyncLocalStorage context, so child spans (net.request/fetch) lose the parent.
 *
 * This patch:
 * 1. Re-wraps ipcMain.handle/handleOnce after dd-trace. Our wrapper runs INSIDE dd-trace's
 *    tracePromise callback (where the handle span IS in the store), and uses
 *    tracer.scope().activate() — which internally calls AsyncLocalStorage.run() — to create
 *    a proper async scope that survives through Electron's native network calls.
 * 2. Wraps globalThis.fetch so the active span context is re-activated at the call boundary.
 *    dd-trace's undici/fetch plugin loses the context through a different path than net.request,
 *    so this ensures fetch spans also get the correct parent.
 */
export function patchIpcHandleContext(tracer: typeof import('dd-trace').default): void {
  try {
    const { ipcMain } = _require('electron') as typeof import('electron');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function wrapHandler(listener: (...args: any[]) => any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return function (event: any, ...args: any[]) {
        const span = tracer.scope().active();
        if (span) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument
          return tracer.scope().activate(span, () => listener(event, ...args));
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument
        return listener(event, ...args);
      };
    }

    const ddWrappedHandle = ipcMain.handle.bind(ipcMain);
    const ddWrappedHandleOnce = ipcMain.handleOnce.bind(ipcMain);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.handle = function (channel: string, listener: (...args: any[]) => any) {
      return ddWrappedHandle(channel, wrapHandler(listener));
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.handleOnce = function (channel: string, listener: (...args: any[]) => any) {
      return ddWrappedHandleOnce(channel, wrapHandler(listener));
    };
  } catch {
    // electron not available — skip
  }
}

export function patchFetchContext(tracer: typeof import('dd-trace').default): void {
  const originalFetch = globalThis.fetch;
  if (!originalFetch) return;

  globalThis.fetch = function (...args: Parameters<typeof fetch>) {
    const span = tracer.scope().active();
    if (span) {
      return tracer.scope().activate(span, () => originalFetch.apply(globalThis, args));
    }
    return originalFetch.apply(globalThis, args);
  } as typeof globalThis.fetch;
}
