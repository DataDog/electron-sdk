import ddTrace from 'dd-trace';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
type IpcEvent = Electron.IpcMainEvent | Electron.IpcMainInvokeEvent;

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function wrap(obj: object, method: string, wrapper: (original: AnyFn) => AnyFn): void {
  const record = obj as Record<string, unknown>;
  record[method] = wrapper((record[method] as AnyFn).bind(obj));
}

function wrapAddListener(
  spanName: string,
  mappings: Record<string, WeakMap<AnyFn, AnyFn>>
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
      return addListener.call(this, ipcChannel, wrappedListener) as unknown;
    };
}

function wrapRemoveListener(mappings: Record<string, WeakMap<AnyFn, AnyFn>>): (remove: AnyFn) => AnyFn {
  return (removeListener) =>
    function (this: unknown, ipcChannel: string, listener: AnyFn) {
      const wrapper = mappings[ipcChannel]?.get(listener);
      return removeListener.call(this, ipcChannel, wrapper ?? listener) as unknown;
    };
}

function wrapRemoveHandler(mappings: Record<string, WeakMap<AnyFn, AnyFn>>): (remove: AnyFn) => AnyFn {
  return (removeHandler) =>
    function (this: unknown, ipcChannel: string) {
      delete mappings[ipcChannel];
      return removeHandler.call(this, ipcChannel) as unknown;
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
      return removeAllListeners.call(this, ipcChannel) as unknown;
    };
}

export function patchIpcMain(ipcMain: Electron.IpcMain): void {
  const listeners: Record<string, WeakMap<AnyFn, AnyFn>> = {};
  const handlers: Record<string, WeakMap<AnyFn, AnyFn>> = {};

  wrap(ipcMain, 'addListener', wrapAddListener('electron.main.receive', listeners));
  wrap(ipcMain, 'handle', wrapAddListener('electron.main.handle', handlers));
  wrap(ipcMain, 'handleOnce', wrapAddListener('electron.main.handle', handlers));
  // `off` is the alias for `removeListener` - event namespace only, not request handlers
  wrap(ipcMain, 'off', wrapRemoveListener(listeners));
  wrap(ipcMain, 'on', wrapAddListener('electron.main.receive', listeners));
  wrap(ipcMain, 'once', wrapAddListener('electron.main.receive', listeners));
  wrap(ipcMain, 'removeAllListeners', wrapRemoveAllListeners(listeners));
  wrap(ipcMain, 'removeHandler', wrapRemoveHandler(handlers));
  wrap(ipcMain, 'removeListener', wrapRemoveListener(listeners));
}
