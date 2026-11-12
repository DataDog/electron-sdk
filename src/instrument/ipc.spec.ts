import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { IPC_HANDLE_CHANNEL, type IpcHandlerCall } from '../common';
import { patchIpcHandlers } from './ipc';

vi.mock('../domain/telemetry', () => ({
  monitor: (fn: unknown) => fn,
  callMonitored: (fn: () => unknown) => fn(),
}));

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const invokeEvent = {} as Electron.IpcMainInvokeEvent;

interface FakeIpc {
  handle: (channel: string, handler: unknown) => void;
  invoke: (channel: string, ...args: unknown[]) => unknown;
}

// Registers like Electron's `IpcMainImpl.handle`, errors included:
// https://github.com/electron/electron/blob/v41.1.0/lib/browser/ipc-main-impl.ts
function createFakeIpc(): FakeIpc {
  const handlers = new Map<string, Handler>();
  return {
    handle: vi.fn((channel: string, handler: unknown) => {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      if (typeof handler !== 'function') {
        throw new TypeError(`Expected handler to be a function, but found type '${typeof handler}'`);
      }
      handlers.set(channel, handler as Handler);
    }),
    invoke: (channel, ...args) => handlers.get(channel)!(invokeEvent, ...args),
  };
}

function createFakeWebContents() {
  return Object.assign(new EventEmitter(), { ipc: createFakeIpc(), mainFrame: { ipc: createFakeIpc() } });
}

type FakeWebContents = ReturnType<typeof createFakeWebContents>;

describe('patchIpcHandlers', () => {
  let app: EventEmitter;
  let ipcMain: FakeIpc;
  let messages: IpcHandlerCall[];
  const onMessage = (message: unknown) => messages.push(message as IpcHandlerCall);

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date', 'performance', 'setTimeout'] });
    app = new EventEmitter();
    ipcMain = createFakeIpc();
    messages = [];
    DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL).subscribe(onMessage);
    patchIpcHandlers(app as unknown as Electron.App, ipcMain as unknown as Electron.IpcMain);
  });

  afterEach(() => {
    DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL).unsubscribe(onMessage);
    vi.useRealTimers();
  });

  function createWebContents() {
    const webContents = createFakeWebContents();
    app.emit('web-contents-created', {}, webContents);
    return webContents;
  }

  it('publishes a handler call with its channel, start time and duration once it settles', async () => {
    ipcMain.handle('settings:get', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'value';
    });

    const result = ipcMain.invoke('settings:get') as Promise<unknown>;
    expect(messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);

    await expect(result).resolves.toBe('value');
    expect(messages).toEqual([{ channel: 'settings:get', startTime: 1_000, duration: 50, isError: false }]);
  });

  it('times overlapping calls on the same channel separately', async () => {
    ipcMain.handle(
      'settings:get',
      (_event: Electron.IpcMainInvokeEvent, delay: number) => new Promise((resolve) => setTimeout(resolve, delay))
    );

    const slowCall = ipcMain.invoke('settings:get', 50);
    await vi.advanceTimersByTimeAsync(5);
    const fastCall = ipcMain.invoke('settings:get', 10);
    await vi.advanceTimersByTimeAsync(45);
    await Promise.all([slowCall, fastCall]);

    expect(messages.map(({ startTime, duration }) => ({ startTime, duration }))).toEqual([
      { startTime: 1_005, duration: 10 },
      { startTime: 1_000, duration: 50 },
    ]);
  });

  it('returns a synchronous result as is', () => {
    const value = {};
    ipcMain.handle('settings:get', () => value);

    expect(ipcMain.invoke('settings:get')).toBe(value);
    expect(messages).toEqual([expect.objectContaining({ isError: false })]);
  });

  it.each([
    { target: 'webContents.ipc', getIpc: (webContents: FakeWebContents) => webContents.ipc },
    { target: 'webContents.mainFrame.ipc', getIpc: (webContents: FakeWebContents) => webContents.mainFrame.ipc },
    {
      target: 'a created frame ipc',
      getIpc: (webContents: FakeWebContents) => {
        const frame = { ipc: createFakeIpc() };
        webContents.emit('frame-created', {}, { frame });
        return frame.ipc;
      },
    },
  ])('publishes a call to a handler registered on $target', ({ getIpc }) => {
    const ipc = getIpc(createWebContents());
    ipc.handle('settings:get', () => 'value');

    expect(ipc.invoke('settings:get')).toBe('value');
    expect(messages).toEqual([expect.objectContaining({ channel: 'settings:get' })]);
  });

  it('patches a frame once when it is reported again', () => {
    const webContents = createWebContents();
    webContents.emit('frame-created', {}, { frame: webContents.mainFrame });
    webContents.mainFrame.ipc.handle('settings:get', () => 'value');

    webContents.mainFrame.ipc.invoke('settings:get');

    expect(messages).toHaveLength(1);
  });

  it('ignores a created frame that is already gone', () => {
    const webContents = createWebContents();

    expect(() => webContents.emit('frame-created', {}, { frame: null })).not.toThrow();
  });

  it('rethrows a synchronous error as is and flags the call', () => {
    const error = new Error('boom');
    ipcMain.handle('settings:get', () => {
      throw error;
    });

    expect(() => ipcMain.invoke('settings:get')).toThrow(error);
    expect(messages).toEqual([expect.objectContaining({ isError: true })]);
  });

  it('rejects with the handler error and flags the call', async () => {
    const error = new Error('boom');
    ipcMain.handle('settings:get', () => Promise.reject(error));

    await expect(ipcMain.invoke('settings:get')).rejects.toBe(error);
    expect(messages).toEqual([expect.objectContaining({ isError: true })]);
  });

  it('publishes a thenable result once it settles, calling its then once and keeping its value', async () => {
    const then = vi.fn((onFulfilled: (value: string) => void) => {
      setTimeout(() => onFulfilled('value'), 50);
    });
    ipcMain.handle('settings:get', () => ({ then }));

    const result = ipcMain.invoke('settings:get') as Promise<unknown>;
    await vi.advanceTimersByTimeAsync(49);
    expect(messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('value');
    expect(then).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([expect.objectContaining({ duration: 50, isError: false })]);
  });

  it('calls the handler untouched while nothing subscribes', () => {
    DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL).unsubscribe(onMessage);
    const promise = Promise.resolve('value');
    ipcMain.handle('settings:get', () => promise);

    expect(ipcMain.invoke('settings:get')).toBe(promise);
    expect(messages).toEqual([]);
  });

  it('publishes the calls of a handler registered before the SDK subscribes', () => {
    DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL).unsubscribe(onMessage);
    ipcMain.handle('settings:get', () => 'value');
    DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL).subscribe(onMessage);

    ipcMain.invoke('settings:get');

    expect(messages).toHaveLength(1);
  });

  it.each([
    { description: 'while the SDK subscribes', subscribed: true },
    { description: 'while nothing subscribes', subscribed: false },
  ])('passes the handler its event and arguments $description', ({ subscribed }) => {
    if (!subscribed) {
      DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL).unsubscribe(onMessage);
    }
    const handler = vi.fn();
    ipcMain.handle('settings:get', handler);

    ipcMain.invoke('settings:get', 'theme', 1);

    expect(handler).toHaveBeenCalledWith(invokeEvent, 'theme', 1);
    expect(handler.mock.calls[0][0]).toBe(invokeEvent);
  });

  it.each([
    {
      description: 'a handler that is not a function',
      register: (ipc: FakeIpc) => ipc.handle('settings:get', 'not a function'),
      error: "Expected handler to be a function, but found type 'string'",
    },
    {
      description: 'a second handler for a channel',
      register: (ipc: FakeIpc) => {
        ipc.handle('settings:get', () => 'value');
        ipc.handle('settings:get', () => 'value');
      },
      error: "Attempted to register a second handler for 'settings:get'",
    },
  ])('keeps the error Electron raises for $description', ({ register, error }) => {
    expect(() => register(ipcMain)).toThrow(error);
  });
});
