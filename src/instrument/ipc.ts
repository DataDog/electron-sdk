import ddTrace from '../entries/instrument-prelude';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
type IpcEvent = Electron.IpcMainEvent | Electron.IpcMainInvokeEvent;

const wrappedWebContents = new WeakSet<Electron.WebContents>();

export function patchIpcMain(ipcMain: Electron.IpcMain): void {
  const listeners: Record<string, WeakMap<AnyFn, AnyFn[]>> = {};
  const handlers: Record<string, WeakMap<AnyFn, AnyFn[]>> = {};

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

export function patchWebContents(BrowserWindow: typeof Electron.BrowserWindow): void {
  // Walk the prototype chain to find where the webContents getter is actually defined.
  // When patchBrowserWindow runs before this function it replaces electron.BrowserWindow
  // with DatadogBrowserWindow (a subclass), so the getter lives on the parent prototype
  // (OriginalBrowserWindow.prototype), not on DatadogBrowserWindow.prototype directly.
  // Patching the prototype where the getter is defined ensures the wrapper runs for all
  // real BrowserWindow instances regardless of call order.
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

function wrapAddListener(
  spanName: string,
  mappings: Record<string, WeakMap<AnyFn, AnyFn[]>>
): (addListener: AnyFn) => AnyFn {
  return (addListener) =>
    function (this: unknown, ipcChannel: string, listener: AnyFn) {
      if (ipcChannel.startsWith('datadog:')) {
        return addListener.call(this, ipcChannel, listener) as unknown;
      }

      const wrappedListener = (event: IpcEvent, ...args: unknown[]) => {
        const lastArg = args[args.length - 1];
        const childOf = lastArg !== null && typeof lastArg === 'object' ? ddTrace.extract('text_map', lastArg) : null;
        const callArgs = childOf ? args.slice(0, -1) : args;

        const span = ddTrace.startSpan(spanName, {
          childOf: childOf ?? undefined,
          tags: {
            'span.kind': 'consumer',
            component: 'electron',
            'resource.name': ipcChannel,
            'span.type': 'worker',
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

      // EventEmitter allows the same listener to be registered multiple times on a channel, each with
      // its own registration. Track a stack of wrappers per original listener so removeListener can pop
      // and remove one wrapper at a time (LIFO) instead of overwriting and leaking earlier registrations.
      const mapping = mappings[ipcChannel] ?? (mappings[ipcChannel] = new WeakMap());
      const wrappers = mapping.get(listener) ?? [];
      wrappers.push(wrappedListener);
      mapping.set(listener, wrappers);
      return addListener.call(this, ipcChannel, wrappedListener) as unknown;
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
    // The producer span is created for main-side trace visibility, but the trace carrier is
    // intentionally NOT injected into the payload: renderer-side ipcRenderer is not yet instrumented
    // to consume/strip it, so injecting would mutate the app's IPC args (breaking channels that
    // check arity or treat the last arg as options). Carrier injection must be re-added together
    // with the matching renderer extraction when ipcRenderer instrumentation lands.
    const span = ddTrace.startSpan('electron.main.send', {
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
    try {
      original(channel, ...args);
    } catch (err) {
      span.setTag('error', err);
      throw err;
    } finally {
      span.finish();
    }
    return undefined;
  });

  wrap(webContents, 'sendToFrame', (original) => (frameId: unknown, channel: string, ...args: unknown[]) => {
    if (channel.startsWith('datadog:')) {
      return original(frameId, channel, ...args) as unknown;
    }
    // The producer span is created for main-side trace visibility, but the trace carrier is
    // intentionally NOT injected into the payload: renderer-side ipcRenderer is not yet instrumented
    // to consume/strip it, so injecting would mutate the app's IPC args (breaking channels that
    // check arity or treat the last arg as options). Carrier injection must be re-added together
    // with the matching renderer extraction when ipcRenderer instrumentation lands.
    const span = ddTrace.startSpan('electron.main.send', {
      childOf: ddTrace.scope().active() ?? undefined,
      tags: {
        'span.kind': 'producer',
        'span.type': 'worker',
        component: 'electron',
        'resource.name': channel,
      },
    });
    try {
      original(frameId, channel, ...args);
    } catch (err) {
      span.setTag('error', err);
      throw err;
    } finally {
      span.finish();
    }
    return undefined;
  });
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function wrap(obj: object, method: string, wrapper: (original: AnyFn) => AnyFn): void {
  const record = obj as Record<string, unknown>;
  record[method] = wrapper((record[method] as AnyFn).bind(obj));
}
