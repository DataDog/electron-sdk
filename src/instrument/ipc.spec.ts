import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcChannelMessage } from './ipc';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

describe('patchIpcMain', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    // The event handler is module-level, global state (no diagnostics_channel to unsubscribe from),
    // so it must not leak a registration into a later test.
    const { setIpcEventHandler } = await import('./ipc');
    setIpcEventHandler(() => undefined);
  });

  // Each vi.fn() captures the wrapped listener the wrapper passes to it in _wrapped.
  // After patchIpcMain(), calling (ipcMain.handle as AnyFn)('ch', handler) invokes the wrapper
  // which calls the original vi.fn() with ('ch', wrappedHandler) - stored in _wrapped['handle:ch'].
  function makeMockIpcMain() {
    const _wrapped: Record<string, AnyFn> = {};
    return {
      _wrapped,
      addListener: vi.fn((ch: string, l: AnyFn) => {
        _wrapped[`addListener:${ch}`] = l;
      }),
      handle: vi.fn((ch: string, l: AnyFn) => {
        _wrapped[`handle:${ch}`] = l;
      }),
      handleOnce: vi.fn((ch: string, l: AnyFn) => {
        _wrapped[`handleOnce:${ch}`] = l;
      }),
      off: vi.fn((ch: string, l: AnyFn) => {
        _wrapped[`off:${ch}`] = l;
      }),
      on: vi.fn((ch: string, l: AnyFn) => {
        _wrapped[`on:${ch}`] = l;
      }),
      once: vi.fn((ch: string, l: AnyFn) => {
        _wrapped[`once:${ch}`] = l;
      }),
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn(),
      removeListener: vi.fn((ch: string, l: AnyFn) => {
        _wrapped[`removeListener:${ch}`] = l;
      }),
    };
  }

  // Patches ipcMain and registers a no-op listener on every method so _wrapped is populated.
  async function setup() {
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    const noop = vi.fn();
    (ipcMain.handle as unknown as AnyFn)('ping', noop);
    (ipcMain.on as unknown as AnyFn)('ping', noop);
    (ipcMain.addListener as unknown as AnyFn)('ping', noop);
    (ipcMain.once as unknown as AnyFn)('ping', noop);
    return ipcMain;
  }

  const listenerMethods = [
    { method: 'on', expectedMethod: 'on', storageKey: 'on' },
    { method: 'addListener', expectedMethod: 'on', storageKey: 'addListener' },
    // `once` registers its wrapper through the raw addListener (not Node's `once`) to avoid the
    // double-wrapping that would otherwise happen when Node's `once` delegates to the patched `on`.
    { method: 'once', expectedMethod: 'on', storageKey: 'addListener' },
    { method: 'handle', expectedMethod: 'handle', storageKey: 'handle' },
    // handleOnce is not patched (it delegates to the patched `handle`); covered by a dedicated
    // real-delegation test below, which the independent mock methods cannot model.
  ] as const;

  it.each(listenerMethods)(
    'publishes a destination-role event for $method when the appended id carrier is present',
    async ({ method, expectedMethod, storageKey }) => {
      const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
      const received: IpcChannelMessage[] = [];
      setIpcEventHandler((message) => received.push(message));
      const ipcMain = makeMockIpcMain();
      patchIpcMain(ipcMain as unknown as Electron.IpcMain);
      (ipcMain[method] as unknown as AnyFn)('ping', vi.fn());

      ipcMain._wrapped[`${storageKey}:ping`]({}, { __ddIpcId: 'call-1' });

      expect(received).toEqual([
        expect.objectContaining({
          role: 'destination',
          id: 'call-1',
          method: expectedMethod,
          channel: 'ping',
          error: false,
        }),
      ]);
    }
  );

  it.each(listenerMethods)(
    'does not publish an event for $method when no id carrier is appended',
    async ({ method, storageKey }) => {
      const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
      const received: IpcChannelMessage[] = [];
      setIpcEventHandler((message) => received.push(message));
      const ipcMain = makeMockIpcMain();
      patchIpcMain(ipcMain as unknown as Electron.IpcMain);
      const handler = vi.fn();
      (ipcMain[method] as unknown as AnyFn)('ping', handler);

      ipcMain._wrapped[`${storageKey}:ping`]({});

      expect(received).toEqual([]);
      expect(handler).toHaveBeenCalled();
    }
  );

  it.each(listenerMethods)(
    'does not publish an event for datadog: prefixed channels on $method',
    async ({ method }) => {
      const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
      const received: IpcChannelMessage[] = [];
      setIpcEventHandler((message) => received.push(message));
      const ipcMain = makeMockIpcMain();
      patchIpcMain(ipcMain as unknown as Electron.IpcMain);
      const handler = vi.fn();
      (ipcMain[method] as unknown as AnyFn)('datadog:bridge-send', handler);
      ipcMain._wrapped[`${method}:datadog:bridge-send`]?.({}, { __ddIpcId: 'call-x' });
      expect(received).toEqual([]);
      expect(handler).toHaveBeenCalled();
    }
  );

  it('extracts the appended carrier and strips it before the real handler runs', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
    const received: IpcChannelMessage[] = [];
    setIpcEventHandler((message) => received.push(message));
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)('get-profile', handler);

    await ipcMain._wrapped['handle:get-profile']({} /* event */, 'userId123', { __ddIpcId: 'call-abc' });

    expect(received).toEqual([
      expect.objectContaining({ role: 'destination', id: 'call-abc', method: 'handle', channel: 'get-profile' }),
    ]);
    expect(handler).toHaveBeenCalledWith(expect.anything(), 'userId123');
  });

  it('publishes an event with error true when handler throws synchronously', async () => {
    const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
    const received: IpcChannelMessage[] = [];
    setIpcEventHandler((message) => received.push(message));
    const err = new Error('boom');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => {
        throw err;
      })
    );
    expect(() => {
      ipcMain._wrapped['handle:ping']({}, { __ddIpcId: 'call-2' });
    }).toThrow(err);
    expect(received).toEqual([expect.objectContaining({ id: 'call-2', error: true })]);
  });

  it('preserves the app handler result when the event handler throws', async () => {
    // A failure publishing the event must not affect the value the app returns from the handler.
    const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
    setIpcEventHandler(() => {
      throw new Error('handler boom');
    });
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => 'app-result')
    );
    let result: unknown;
    expect(() => {
      result = ipcMain._wrapped['handle:ping']({}, { __ddIpcId: 'call-3' });
    }).not.toThrow();
    expect(result).toBe('app-result');
  });

  it('still propagates the app error when the event handler also throws', async () => {
    const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
    setIpcEventHandler(() => {
      throw new Error('handler boom');
    });
    const appErr = new Error('handler err');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => {
        throw appErr;
      })
    );
    expect(() => {
      ipcMain._wrapped['handle:ping']({}, { __ddIpcId: 'call-4' });
    }).toThrow(appErr);
  });

  it('publishes the event after the promise resolves', async () => {
    const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
    const received: IpcChannelMessage[] = [];
    setIpcEventHandler((message) => received.push(message));
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    let resolve!: () => void;
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => new Promise<void>((r) => (resolve = r)))
    );
    const result = ipcMain._wrapped['handle:ping']({}, { __ddIpcId: 'call-5' }) as Promise<unknown>;
    expect(received).toEqual([]);
    resolve();
    await result;
    await Promise.resolve();
    expect(received).toEqual([expect.objectContaining({ id: 'call-5', error: false })]);
  });

  it('publishes the event with error true after the promise rejects', async () => {
    const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
    const received: IpcChannelMessage[] = [];
    setIpcEventHandler((message) => received.push(message));
    const err = new Error('async boom');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => Promise.reject(err))
    );
    await (ipcMain._wrapped['handle:ping']({}, { __ddIpcId: 'call-6' }) as Promise<unknown>).catch(() => null);
    await Promise.resolve();
    expect(received).toEqual([expect.objectContaining({ id: 'call-6', error: true })]);
  });

  it('does not extract or strip a last argument that is not an id carrier', async () => {
    // A last argument that looks like a trace carrier belongs to the app: only an object shaped like
    // { __ddIpcId: string } is treated as our own appended carrier.
    const handler = vi.fn();
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)('ping', handler);
    const carrierLike = { 'x-datadog-trace-id': '123' };
    ipcMain._wrapped['handle:ping']({}, 'payload', carrierLike);
    expect(handler).toHaveBeenCalledWith({}, 'payload', carrierLike);
  });

  it('removeListener passes the wrapped listener (not the original) to the underlying method', async () => {
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    const original = vi.fn();
    (ipcMain.on as unknown as AnyFn)('ping', original);
    const wrappedFn = ipcMain._wrapped['on:ping'];
    (ipcMain.removeListener as unknown as AnyFn)('ping', original);
    const passed = ipcMain._wrapped['removeListener:ping'];
    expect(passed).toBe(wrappedFn);
  });

  it('removeAllListeners does not throw', async () => {
    const ipcMain = await setup();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    expect(() => (ipcMain.removeAllListeners as unknown as AnyFn)()).not.toThrow();
  });

  // A real EventEmitter augmented with the Electron-only ipcMain methods that patchIpcMain wraps
  // (handle/handleOnce/removeHandler). This exercises genuine removeAllListeners/emit semantics,
  // which mocks cannot reproduce.
  function makeRealIpcMain() {
    return Object.assign(new EventEmitter(), {
      handle: vi.fn(),
      handleOnce: vi.fn(),
      removeHandler: vi.fn(),
    });
  }

  it('removeAllListeners() with no channel removes every listener on a real EventEmitter', async () => {
    // The "remove all" path is keyed on arguments.length === 0, so forwarding an explicit undefined
    // would be a no-op and leave the handler registered.
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeRealIpcMain();
    patchIpcMain(ipcMain);

    const handler = vi.fn();
    ipcMain.on('foo', handler);

    ipcMain.removeAllListeners();
    ipcMain.emit('foo', {});

    expect(handler).not.toHaveBeenCalled();
    expect(ipcMain.listenerCount('foo')).toBe(0);
  });

  it('removeAllListeners(channel) removes only that channel on a real EventEmitter', async () => {
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeRealIpcMain();
    patchIpcMain(ipcMain);

    const fooHandler = vi.fn();
    const barHandler = vi.fn();
    ipcMain.on('foo', fooHandler);
    ipcMain.on('bar', barHandler);

    ipcMain.removeAllListeners('foo');
    ipcMain.emit('foo', {});
    ipcMain.emit('bar', {});

    expect(fooHandler).not.toHaveBeenCalled();
    expect(barHandler).toHaveBeenCalledTimes(1);
  });

  it('removes each registration of a duplicated listener on a real EventEmitter (LIFO)', async () => {
    // EventEmitter allows the same listener to be registered twice on a channel. Before the fix the
    // single-wrapper WeakMap overwrote the first wrapper, so the earlier registration could never be
    // removed and kept firing. Each registration must now be individually removable.
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeRealIpcMain();
    patchIpcMain(ipcMain);

    const handler = vi.fn();
    ipcMain.on('foo', handler);
    ipcMain.on('foo', handler);

    // Two distinct wrappers are registered on the emitter, one per registration.
    expect(ipcMain.listenerCount('foo')).toBe(2);

    ipcMain.removeListener('foo', handler);
    expect(ipcMain.listenerCount('foo')).toBe(1);
    ipcMain.emit('foo', {});
    expect(handler).toHaveBeenCalledTimes(1);

    handler.mockClear();
    ipcMain.removeListener('foo', handler);
    expect(ipcMain.listenerCount('foo')).toBe(0);
    ipcMain.emit('foo', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves process unhandledRejection for a rejecting async on() listener (real EventEmitter)', async () => {
    // A fire-and-forget receive listener that returns a rejecting promise must still surface via
    // process 'unhandledRejection' (which the SDK ErrorCollection listens on). Swallowing the
    // rejection while publishing the event would silently drop the app's error reporting.
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeRealIpcMain();
    patchIpcMain(ipcMain);

    // Temporarily take over unhandledRejection so the real rejection is captured here instead of
    // failing the test runner, then restore the previous listeners.
    const previous = process.listeners('unhandledRejection');
    previous.forEach((l) => process.removeListener('unhandledRejection', l));
    const captured: unknown[] = [];
    const capture = (reason: unknown): void => {
      captured.push(reason);
    };
    process.on('unhandledRejection', capture);

    const rejection = new Error('async listener boom');
    try {
      // An async listener that returns a rejecting promise is exactly the scenario under test.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      ipcMain.on('foo', () => Promise.reject(rejection));
      ipcMain.emit('foo', {});
      // Deterministically flush the microtask queue so Node emits unhandledRejection (no timeout).
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeListener('unhandledRejection', capture);
      previous.forEach((l) => process.on('unhandledRejection', l));
    }

    expect(captured).toContain(rejection);
  });

  it('supports channel names that collide with Object.prototype keys (real EventEmitter)', async () => {
    // A plain-object channel map would return an inherited value (e.g. Object.prototype.toString)
    // for these names and throw on the following mapping.get. The per-channel maps must be
    // null-prototype so user-defined channel names never resolve to inherited properties.
    const { patchIpcMain } = await import('./ipc');
    for (const channel of ['__proto__', 'constructor', 'toString']) {
      const ipcMain = makeRealIpcMain();
      patchIpcMain(ipcMain);
      const handler = vi.fn();
      expect(() => ipcMain.on(channel, handler), channel).not.toThrow();
      ipcMain.emit(channel, {});
      expect(handler, channel).toHaveBeenCalledTimes(1);
    }
  });

  it('does not leak the persistent on() listener after a once() on the same callback fires (real EventEmitter)', async () => {
    // Regression: a once() registration is auto-removed by EventEmitter when it fires, but the SDK's
    // wrapper stack kept that stale wrapper on top. A later removeListener(channel, cb) then popped the
    // already-removed wrapper (a no-op) and left the earlier on() registration leaked and still firing.
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeRealIpcMain();
    patchIpcMain(ipcMain);

    const handler = vi.fn();
    ipcMain.on('foo', handler); // persistent
    ipcMain.once('foo', handler); // one-shot
    expect(ipcMain.listenerCount('foo')).toBe(2);

    // Fire: both run, and the once registration auto-removes.
    ipcMain.emit('foo', {});
    expect(handler).toHaveBeenCalledTimes(2);
    expect(ipcMain.listenerCount('foo')).toBe(1);

    // removeListener must drop the surviving on() registration, not the already-gone once wrapper.
    handler.mockClear();
    ipcMain.removeListener('foo', handler);
    expect(ipcMain.listenerCount('foo')).toBe(0);
    ipcMain.emit('foo', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes the listener exactly once for a once() listener (no double-wrap) (real EventEmitter)', async () => {
    // Node's once() is implemented via this.on(); since `on` is patched, patching `once` to delegate
    // through it would wrap the listener twice and publish duplicate events. The SDK registers the
    // once wrapper via the raw addListener instead, so exactly one event is published.
    const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
    const received: IpcChannelMessage[] = [];
    setIpcEventHandler((message) => received.push(message));
    const ipcMain = makeRealIpcMain();
    patchIpcMain(ipcMain);

    const cb = vi.fn();
    ipcMain.once('foo', cb);
    ipcMain.emit('foo', {}, { __ddIpcId: 'call-once' });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    // once fired: auto-removed, so nothing remains.
    expect(ipcMain.listenerCount('foo')).toBe(0);
    ipcMain.emit('foo', {}, { __ddIpcId: 'call-once-2' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('removeListener removes a once() listener before it fires (real EventEmitter)', async () => {
    // The once wrapper is the one actually registered on the emitter, so removeListener(channel, cb)
    // must remove it — before the fix it popped a wrapper that was never registered and left the
    // listener in place.
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeRealIpcMain();
    patchIpcMain(ipcMain);

    const cb = vi.fn();
    ipcMain.once('bar', cb);
    expect(ipcMain.listenerCount('bar')).toBe(1);

    ipcMain.removeListener('bar', cb);
    expect(ipcMain.listenerCount('bar')).toBe(0);
    ipcMain.emit('bar', {});
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not double-wrap handleOnce, which delegates to the patched handle', async () => {
    // Electron implements handleOnce as this.handle(channel, bridge) where the bridge removes the
    // handler after the first call. Since `handle` is patched, patching handleOnce too would wrap the
    // listener twice → duplicate published events. handleOnce is left unpatched so it delegates to the
    // patched handle, producing exactly one published event. Mocks with independent methods cannot
    // model this delegation, so this uses a fake that mirrors Electron's implementation.
    const { patchIpcMain, setIpcEventHandler } = await import('./ipc');
    const received: IpcChannelMessage[] = [];
    setIpcEventHandler((message) => received.push(message));
    const handlers: Record<string, AnyFn> = {};
    const ipcMain = {
      handle: (ch: string, fn: AnyFn) => {
        handlers[ch] = fn;
      },
      handleOnce(this: { handle: AnyFn; removeHandler: AnyFn }, ch: string, fn: AnyFn) {
        this.handle(ch, (event: unknown, ...args: unknown[]) => {
          this.removeHandler(ch);
          return fn(event, ...args) as unknown;
        });
      },
      removeHandler: (ch: string) => {
        delete handlers[ch];
      },
      addListener: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);

    ipcMain.handleOnce('ping', vi.fn());
    handlers['ping']({}, { __ddIpcId: 'call-handleonce' });

    expect(received).toEqual([expect.objectContaining({ id: 'call-handleonce', method: 'handle', channel: 'ping' })]);
  });

  it('tracks distinct wrappers per registration of the same listener', async () => {
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    const original = vi.fn();
    (ipcMain.on as unknown as AnyFn)('foo', original);
    const firstWrapper = ipcMain._wrapped['on:foo'];
    (ipcMain.on as unknown as AnyFn)('foo', original);
    const secondWrapper = ipcMain._wrapped['on:foo'];
    expect(secondWrapper).not.toBe(firstWrapper);

    // removeListener pops LIFO: the second (most recent) wrapper first, then the first.
    (ipcMain.removeListener as unknown as AnyFn)('foo', original);
    expect(ipcMain._wrapped['removeListener:foo']).toBe(secondWrapper);
    (ipcMain.removeListener as unknown as AnyFn)('foo', original);
    expect(ipcMain._wrapped['removeListener:foo']).toBe(firstWrapper);

    // With no wrappers left, it falls back to the original listener.
    (ipcMain.removeListener as unknown as AnyFn)('foo', original);
    expect(ipcMain._wrapped['removeListener:foo']).toBe(original);
  });

  it('removeHandler does not throw', async () => {
    const ipcMain = await setup();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    expect(() => (ipcMain.removeHandler as unknown as AnyFn)('ping')).not.toThrow();
  });
});

describe('patchWebContents', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { setIpcEventHandler } = await import('./ipc');
    setIpcEventHandler(() => undefined);
  });

  function makeMockWebContents() {
    return {
      send: vi.fn(),
      sendToFrame: vi.fn(),
    };
  }

  function makeMockBrowserWindow(webContents: ReturnType<typeof makeMockWebContents>) {
    const proto = {
      get webContents() {
        return webContents;
      },
    };
    return { prototype: proto } as unknown as typeof Electron.BrowserWindow;
  }

  async function setup() {
    const { patchWebContents, setIpcEventHandler } = await import('./ipc');
    const wc = makeMockWebContents();
    const sendSpy = wc.send;
    const sendToFrameSpy = wc.sendToFrame;
    const BrowserWindow = makeMockBrowserWindow(wc);
    patchWebContents(BrowserWindow);
    const instance = Object.create(BrowserWindow.prototype) as {
      webContents: ReturnType<typeof makeMockWebContents>;
    };
    return { wc, instance, BrowserWindow, sendSpy, sendToFrameSpy, setIpcEventHandler };
  }

  type SetupResult = Awaited<ReturnType<typeof setup>>;

  const sendMethods: {
    name: string;
    invoke: (r: SetupResult) => void;
    invokeDatadog: (r: SetupResult) => void;
    datadogArgs: unknown[];
    getSpy: (r: SetupResult) => MockInstance;
  }[] = [
    {
      name: 'send',
      invoke: ({ instance }) => {
        instance.webContents.send('my-channel', 'arg1');
      },
      invokeDatadog: ({ instance }) => {
        instance.webContents.send('datadog:bridge-event', 'payload');
      },
      datadogArgs: ['datadog:bridge-event', 'payload'],
      getSpy: ({ sendSpy }) => sendSpy,
    },
    {
      name: 'sendToFrame',
      invoke: ({ instance }) => {
        instance.webContents.sendToFrame(1, 'my-channel', 'arg1');
      },
      invokeDatadog: ({ instance }) => {
        instance.webContents.sendToFrame(1, 'datadog:bridge-event', 'payload');
      },
      datadogArgs: [1, 'datadog:bridge-event', 'payload'],
      getSpy: ({ sendToFrameSpy }) => sendToFrameSpy,
    },
  ];

  it.each(sendMethods)('publishes a source-role event for webContents.$name', async ({ invoke, getSpy }) => {
    const result = await setup();
    const received: IpcChannelMessage[] = [];
    result.setIpcEventHandler((message) => received.push(message));
    invoke(result);
    expect(received).toEqual([
      expect.objectContaining({ role: 'source', method: 'send', channel: 'my-channel', error: false }),
    ]);
    // The generated id must be threaded through as the appended carrier on the underlying call.
    const lastCallArgs = getSpy(result).mock.calls[0] as unknown[];
    const carrier = lastCallArgs[lastCallArgs.length - 1] as { __ddIpcId: string };
    expect(carrier.__ddIpcId).toBe(received[0].id);
  });

  it('appends an id carrier as the last argument for webContents.send', async () => {
    const result = await setup();
    result.instance.webContents.send('my-channel', 'arg1');
    expect(result.sendSpy).toHaveBeenCalledTimes(1);
    const args = result.sendSpy.mock.calls[0] as unknown[];
    expect(args[0]).toBe('my-channel');
    expect(args[1]).toBe('arg1');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(args[2]).toEqual({ __ddIpcId: expect.any(String) });
  });

  it('appends an id carrier as the last argument for webContents.sendToFrame', async () => {
    const result = await setup();
    result.instance.webContents.sendToFrame(1, 'my-channel', 'arg1');
    expect(result.sendToFrameSpy).toHaveBeenCalledTimes(1);
    const args = result.sendToFrameSpy.mock.calls[0] as unknown[];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(args).toEqual([1, 'my-channel', 'arg1', { __ddIpcId: expect.any(String) }]);
  });

  it.each(sendMethods)(
    'skips instrumentation for datadog: prefixed channels in $name',
    async ({ invokeDatadog, getSpy, datadogArgs }) => {
      const result = await setup();
      const received: IpcChannelMessage[] = [];
      result.setIpcEventHandler((message) => received.push(message));
      invokeDatadog(result);
      expect(received).toEqual([]);
      expect(getSpy(result)).toHaveBeenCalledWith(...datadogArgs);
    }
  );

  it.each(sendMethods)(
    'publishes an event with error true when underlying $name throws synchronously',
    async ({ getSpy, invoke }) => {
      const err = new Error('send boom');
      const result = await setup();
      const received: IpcChannelMessage[] = [];
      result.setIpcEventHandler((message) => received.push(message));
      getSpy(result).mockImplementation(() => {
        throw err;
      });
      expect(() => invoke(result)).toThrow(err);
      expect(received).toEqual([expect.objectContaining({ error: true })]);
    }
  );

  it('does not throw and still calls the original when the event handler throws', async () => {
    // A failure publishing the event must not break webContents.send.
    const result = await setup();
    result.setIpcEventHandler(() => {
      throw new Error('handler boom');
    });
    expect(() => {
      result.instance.webContents.send('my-channel', 'arg1');
    }).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(result.sendSpy).toHaveBeenCalledWith('my-channel', 'arg1', { __ddIpcId: expect.any(String) });
  });

  it('patches the parent prototype when BrowserWindow is a subclass without own webContents getter', async () => {
    // Simulates the DatadogBrowserWindow scenario: patchBrowserWindow creates a subclass
    // and patchWebContents receives the subclass. The getter lives on the parent prototype.
    const { patchWebContents, setIpcEventHandler } = await import('./ipc');
    const received: IpcChannelMessage[] = [];
    setIpcEventHandler((message) => received.push(message));
    const wc = makeMockWebContents();
    const parentProto = {
      get webContents() {
        return wc;
      },
    };
    const subclassProto = Object.create(parentProto) as Record<string, unknown>;
    const SubclassBrowserWindow = { prototype: subclassProto } as unknown as typeof Electron.BrowserWindow;
    patchWebContents(SubclassBrowserWindow);
    // parentProto getter should have been replaced, not subclassProto
    expect(Object.getOwnPropertyDescriptor(subclassProto, 'webContents')).toBeUndefined();
    const instance = Object.create(subclassProto) as { webContents: ReturnType<typeof makeMockWebContents> };
    instance.webContents.send('test-channel', 'arg');
    expect(received).toEqual([expect.objectContaining({ role: 'source', channel: 'test-channel' })]);
  });

  it('only wraps webContents once when accessed multiple times', async () => {
    const result = await setup();
    const received: IpcChannelMessage[] = [];
    result.setIpcEventHandler((message) => received.push(message));
    result.instance.webContents.send('ch', 'a');
    received.length = 0;
    result.instance.webContents.send('ch', 'b');
    expect(received).toHaveLength(1);
  });
});
