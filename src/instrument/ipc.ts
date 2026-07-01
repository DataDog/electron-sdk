import ddTrace from '../entries/instrument-prelude';
import { callMonitored, monitorInstrumentation } from '../domain/telemetry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
type IpcEvent = Electron.IpcMainEvent | Electron.IpcMainInvokeEvent;

const wrappedWebContents = new WeakSet<Electron.WebContents>();

export function patchIpcMain(ipcMain: Electron.IpcMain): void {
  // Null-prototype maps: IPC channel names are arbitrary user strings and may collide with
  // Object.prototype keys (__proto__, constructor, toString). On a plain object those names would
  // resolve to the inherited value on lookup and throw on the subsequent WeakMap access.
  const listeners = Object.create(null) as Record<string, WeakMap<AnyFn, AnyFn[]>>;
  const handlers = Object.create(null) as Record<string, WeakMap<AnyFn, AnyFn[]>>;

  // Captured before patching. `once` registers its single wrapper through the raw addListener (not
  // Node's `once`, which delegates to the now-patched `on` and would wrap the listener twice), and
  // self-removes via the raw removeListener when it fires.
  const rawAddListener = ipcMain.addListener.bind(ipcMain) as AnyFn;
  const rawRemoveListener = ipcMain.removeListener.bind(ipcMain) as AnyFn;

  wrap(ipcMain, 'addListener', wrapAddListener('electron.main.receive', listeners));
  wrap(ipcMain, 'handle', wrapAddListener('electron.main.handle', handlers));
  // handleOnce is intentionally NOT patched: Electron implements it as this.handle(channel, bridge)
  // where bridge removes the handler after the first call. Since `handle` is patched above, wrapping
  // handleOnce too would wrap the listener twice (nested duplicate electron.main.handle spans). Letting
  // it delegate to the patched `handle` produces exactly one span, and Electron's bridge still handles
  // the one-shot removeHandler.
  wrap(ipcMain, 'off', wrapRemoveListener(listeners));
  wrap(ipcMain, 'on', wrapAddListener('electron.main.receive', listeners));
  wrap(ipcMain, 'once', wrapAddListener('electron.main.receive', listeners, { rawAddListener, rawRemoveListener }));
  wrap(ipcMain, 'removeAllListeners', wrapRemoveAllListeners(listeners));
  wrap(ipcMain, 'removeHandler', wrapRemoveHandler(handlers));
  wrap(ipcMain, 'removeListener', wrapRemoveListener(listeners));
}

export function patchWebContents(BrowserWindow: typeof Electron.BrowserWindow): void {
  // Walk the prototype chain to find where the webContents getter is actually defined. It may live
  // on a parent prototype rather than on BrowserWindow.prototype directly (e.g. when the app
  // subclasses BrowserWindow, or across Electron versions). Patching the prototype where the getter
  // is defined ensures the wrapper runs for all real BrowserWindow instances regardless of call order.
  let target: object | null = BrowserWindow.prototype;
  let descriptor: PropertyDescriptor | undefined;
  while (target) {
    descriptor = Object.getOwnPropertyDescriptor(target, 'webContents');
    if (descriptor?.get) break;
    target = Object.getPrototypeOf(target) as object | null;
  }
  if (!target || !descriptor?.get) return;

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalGet = descriptor.get as (this: unknown) => Electron.WebContents;

  Object.defineProperty(target, 'webContents', {
    get(this: unknown) {
      const wc = originalGet.call(this);
      wrapSend(wc);
      return wc;
    },
    configurable: true,
  });
}

interface OnceConfig {
  rawAddListener: AnyFn;
  rawRemoveListener: AnyFn;
}

function wrapAddListener(
  spanName: string,
  mappings: Record<string, WeakMap<AnyFn, AnyFn[]>>,
  once?: OnceConfig
): (addListener: AnyFn) => AnyFn {
  return (addListener) =>
    function (this: unknown, ipcChannel: string, listener: AnyFn) {
      if (ipcChannel.startsWith('datadog:')) {
        return addListener.call(this, ipcChannel, listener) as unknown;
      }

      // EventEmitter allows the same listener to be registered multiple times on a channel, each with
      // its own registration. Track a stack of wrappers per original listener so removeListener can pop
      // and remove one wrapper at a time (LIFO) instead of overwriting and leaking earlier registrations.
      const mapping = mappings[ipcChannel] ?? (mappings[ipcChannel] = new WeakMap());
      const wrappers = mapping.get(listener) ?? [];

      const wrappedListener = (event: IpcEvent, ...args: unknown[]) => {
        if (once) {
          // One-shot semantics implemented against the raw add/remove methods (not Node's `once`,
          // which delegates to the patched `on` and would double-wrap): remove ourselves from the
          // emitter and the tracking stack before running, so the listener fires exactly once and a
          // later removeListener stays consistent.
          once.rawRemoveListener(ipcChannel, wrappedListener);
          const index = wrappers.indexOf(wrappedListener);
          if (index !== -1) wrappers.splice(index, 1);
        }

        // Start the span monitored. If it fails (or the SDK is not set up) the span is undefined and
        // we run the listener raw so app behavior is preserved. We do not extract a carrier from the
        // payload: the SDK does not inject one into IPC messages, so any trace-header-shaped last
        // argument belongs to the app and must be passed through untouched. Carrier extraction will
        // return together with renderer-side injection when ipcRenderer instrumentation lands.
        const span = callMonitored(() =>
          ddTrace.startSpan(spanName, {
            childOf: ddTrace.scope().active() ?? undefined,
            tags: {
              'span.kind': 'consumer',
              component: 'electron',
              'resource.name': ipcChannel,
              'span.type': 'worker',
            },
          })
        );

        if (!span) {
          return listener.call(this, event, ...args) as unknown;
        }

        return ddTrace.scope().activate(span, () => {
          let result: unknown;
          try {
            result = listener.call(this, event, ...args) as unknown;
          } catch (err) {
            // Tag the span monitored, then rethrow outside so invoke() rejections still propagate.
            callMonitored(() => {
              span.setTag('error', err);
              span.finish();
            });
            throw err;
          }

          if (isPromise(result)) {
            // Return the settled-through promise (mirrors dd-trace's tracePromise): finish the span on
            // settle, then re-reject so the rejection keeps propagating. For fire-and-forget receive
            // listeners EventEmitter ignores this return, so re-rejecting preserves the app's (and the
            // SDK ErrorCollection's) process 'unhandledRejection'; for handle/handleOnce it flows on to
            // Electron, which forwards the error to the renderer. Swallowing it here (e.g. via monitor)
            // would drop that rejection entirely.
            return result.then(
              (value) => {
                callMonitored(() => span.finish());
                return value;
              },
              (err: unknown) => {
                callMonitored(() => {
                  span.setTag('error', err);
                  span.finish();
                });
                throw err;
              }
            );
          }

          callMonitored(() => span.finish());
          return result;
        });
      };

      wrappers.push(wrappedListener);
      mapping.set(listener, wrappers);
      // For `once`, register via the raw addListener (not Node's `once`) so the listener is wrapped
      // exactly once; the wrapper above removes itself after the first call.
      const register = once ? once.rawAddListener : addListener;
      return register.call(this, ipcChannel, wrappedListener) as unknown;
    };
}

function wrapRemoveListener(mappings: Record<string, WeakMap<AnyFn, AnyFn[]>>): (remove: AnyFn) => AnyFn {
  return (removeListener) =>
    function (this: unknown, ipcChannel: string, listener: AnyFn) {
      // Pop the most recently added wrapper (LIFO) to mirror EventEmitter.removeListener, which removes
      // the most recently registered matching instance. Fall back to the original listener when we have
      // no wrapper tracked for it.
      const wrappers = mappings[ipcChannel]?.get(listener);
      const wrapper = wrappers?.pop();
      return removeListener.call(this, ipcChannel, wrapper ?? listener) as unknown;
    };
}

function wrapRemoveHandler(mappings: Record<string, WeakMap<AnyFn, AnyFn[]>>): (remove: AnyFn) => AnyFn {
  return (removeHandler) =>
    function (this: unknown, ipcChannel: string) {
      delete mappings[ipcChannel];
      return removeHandler.call(this, ipcChannel) as unknown;
    };
}

function wrapRemoveAllListeners(mappings: Record<string, WeakMap<AnyFn, AnyFn[]>>): (remove: AnyFn) => AnyFn {
  return (removeAllListeners) =>
    function (this: unknown, ...args: [ipcChannel?: string]) {
      // EventEmitter.removeAllListeners() decides "remove all" by arguments.length === 0, not by
      // a falsy check. Forwarding an explicit undefined would target the (empty) `undefined` event
      // and leave every real listener registered, so we must preserve the caller's arity.
      if (args.length === 0) {
        for (const key of Object.keys(mappings)) delete mappings[key];
        return removeAllListeners.call(this) as unknown;
      }
      const [ipcChannel] = args;
      if (ipcChannel !== undefined) delete mappings[ipcChannel];
      return removeAllListeners.call(this, ipcChannel) as unknown;
    };
}

function wrapSend(webContents: Electron.WebContents): void {
  if (wrappedWebContents.has(webContents)) return;
  wrappedWebContents.add(webContents);

  wrap(webContents, 'send', (original) => (channel: string, ...args: unknown[]) => {
    if (channel.startsWith('datadog:')) {
      return original(channel, ...args) as unknown;
    }
    return startSendSpan(channel, () => original(channel, ...args));
  });

  wrap(webContents, 'sendToFrame', (original) => (frameId: unknown, channel: string, ...args: unknown[]) => {
    if (channel.startsWith('datadog:')) {
      return original(frameId, channel, ...args) as unknown;
    }
    return startSendSpan(channel, () => original(frameId, channel, ...args));
  });
}

// The producer span is created for main-side trace visibility, but the trace carrier is
// intentionally NOT injected into the payload: renderer-side ipcRenderer is not yet instrumented
// to consume/strip it, so injecting would mutate the app's IPC args (breaking channels that
// check arity or treat the last arg as options). Carrier injection must be re-added together
// with the matching renderer extraction when ipcRenderer instrumentation lands.
function startSendSpan(channel: string, invokeOriginal: () => unknown): unknown {
  let span: ReturnType<typeof ddTrace.startSpan> | undefined;
  return monitorInstrumentation<unknown>(({ onResult, onError }) => {
    span = ddTrace.startSpan('electron.main.send', {
      // childOf must be passed explicitly: dd-trace's startSpan() does not inherit the active
      // scope automatically. This parents the send to whatever is active (e.g. the
      // electron.main.handle span) when send is called from inside an IPC handler.
      childOf: ddTrace.scope().active() ?? undefined,
      tags: {
        'span.kind': 'producer',
        'span.type': 'worker',
        component: 'electron',
        'resource.name': channel,
      },
    });
    onError((err) => {
      span?.setTag('error', err);
      span?.finish();
    });
    onResult(() => span?.finish());
  }, invokeOriginal);
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function wrap(obj: object, method: string, wrapper: (original: AnyFn) => AnyFn): void {
  const record = obj as Record<string, unknown>;
  record[method] = wrapper((record[method] as AnyFn).bind(obj));
}
