import { isThenable } from '@datadog/browser-core';
import { clocksNow, elapsed, relativeNow } from '@datadog/js-core/time';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { IPC_HANDLE_CHANNEL, type IpcHandlerCall } from '../common';
import { callMonitored, monitor } from '../domain/telemetry';

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ipcHandleChannel = DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL);

/**
 * Times the handlers of IPC calls. A call runs a single handler, the first found on the calling frame's `ipc`, its
 * WebContents's `ipc` or `ipcMain`, and `handle` is an own property of each of them, so each instance is patched.
 */
export function patchIpcHandlers(app: Electron.App, ipcMain: Electron.IpcMain): void {
  const patched = new WeakSet<Electron.IpcMain>();
  const patchHandle = (ipc: Electron.IpcMain): void => {
    if (patched.has(ipc)) {
      return;
    }
    patched.add(ipc);
    const originalHandle = ipc.handle.bind(ipc);
    ipc.handle = (channel: string, handler: unknown) => {
      if (typeof handler !== 'function') {
        // Left unwrapped, so that Electron still rejects it at registration.
        return originalHandle(channel, handler as Handler);
      }
      return originalHandle(channel, timeHandler(channel, handler as Handler));
    };
  };

  patchHandle(ipcMain);
  app.on(
    'web-contents-created',
    monitor((_event: Electron.Event, webContents: Electron.WebContents) => {
      patchHandle(webContents.ipc);
      // frame-created does not fire for the main frame of a window.open popup.
      patchHandle(webContents.mainFrame.ipc);
      webContents.on(
        'frame-created',
        monitor((_frameEvent: Electron.Event, { frame }: Electron.FrameCreatedDetails) => {
          // `frame` is null when read after the frame navigated or was destroyed.
          if (frame) {
            patchHandle(frame.ipc);
          }
        })
      );
    })
  );
}

// Calls the handler directly, so that its errors gain a single SDK frame.
function timeHandler(channel: string, handler: Handler): Handler {
  return (event, ...args) => {
    if (!ipcHandleChannel.hasSubscribers) {
      return handler(event, ...args);
    }

    const start = clocksNow();
    const publish = (isError: boolean) =>
      callMonitored(() => {
        const call: IpcHandlerCall = {
          channel,
          startTime: start.timeStamp,
          duration: elapsed(start.relative, relativeNow()),
          isError,
        };
        ipcHandleChannel.publish(call);
      });

    let result: unknown;
    try {
      result = handler(event, ...args);
    } catch (error) {
      publish(true);
      throw error;
    }

    if (isThenable(result)) {
      // Adopted as Electron does: `then` is called once, since a lazy thenable (e.g. a query builder) runs on each
      // `then` call, and the value is kept even when `then` returns nothing.
      return Promise.resolve(result).then(
        (value) => {
          publish(false);
          return value;
        },
        (error: unknown) => {
          publish(true);
          throw error;
        }
      );
    }

    publish(false);
    return result;
  };
}
