import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

const mockSpan = { setTag: vi.fn(), finish: vi.fn() };
const mockScope = {
  activate: vi.fn((_, fn: () => unknown) => fn()),
  active: vi.fn<() => object | null>(() => null),
};
const mockDdTrace = {
  startSpan: vi.fn(() => mockSpan),
  extract: vi.fn<() => object | null>(() => null),
  scope: vi.fn(() => mockScope),
};

vi.mock('../entries/instrument-prelude', () => ({ default: mockDdTrace }));

describe('patchIpcMain', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // clearAllMocks resets call history but not implementations; restore the span mock defaults so
    // resilience tests that make setTag/finish throw do not leak into later tests.
    mockSpan.setTag.mockReset();
    mockSpan.finish.mockReset();
    mockScope.activate.mockImplementation((_, fn: () => unknown) => fn());
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
    { method: 'on', spanName: 'electron.main.receive', storageKey: 'on' },
    { method: 'addListener', spanName: 'electron.main.receive', storageKey: 'addListener' },
    // `once` registers its wrapper through the raw addListener (not Node's `once`) to avoid the
    // double-wrapping that would otherwise happen when Node's `once` delegates to the patched `on`.
    { method: 'once', spanName: 'electron.main.receive', storageKey: 'addListener' },
    { method: 'handle', spanName: 'electron.main.handle', storageKey: 'handle' },
    // handleOnce is not patched (it delegates to the patched `handle`); covered by a dedicated
    // real-delegation test below, which the independent mock methods cannot model.
  ] as const;

  it.each(listenerMethods)(
    'creates a $spanName consumer span for $method',
    async ({ method, spanName, storageKey }) => {
      const { patchIpcMain } = await import('./ipc');
      const ipcMain = makeMockIpcMain();
      patchIpcMain(ipcMain as unknown as Electron.IpcMain);
      (ipcMain[method] as unknown as AnyFn)('ping', vi.fn());

      ipcMain._wrapped[`${storageKey}:ping`]({});
      expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
        spanName,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          tags: expect.objectContaining({ 'span.kind': 'consumer', component: 'electron', 'span.type': 'worker' }),
        })
      );
      expect(mockSpan.finish).toHaveBeenCalled();
    }
  );

  it.each(listenerMethods)('does not create a span for datadog: prefixed channels on $method', async ({ method }) => {
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    const handler = vi.fn();
    (ipcMain[method] as unknown as AnyFn)('datadog:bridge-send', handler);
    ipcMain._wrapped[`${method}:datadog:bridge-send`]?.({});
    expect(mockDdTrace.startSpan).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('sets span error tag and finishes when handler throws synchronously', async () => {
    const { patchIpcMain } = await import('./ipc');
    const err = new Error('boom');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => {
        throw err;
      })
    );
    try {
      ipcMain._wrapped['handle:ping']({});
    } catch {
      /* expected */
    }
    expect(mockSpan.setTag).toHaveBeenCalledWith('error', err);
    expect(mockSpan.finish).toHaveBeenCalled();
  });

  it('preserves the app handler result when an SDK hook throws (finish throws)', async () => {
    // A tracing failure must not affect the value the app returns from the handler.
    mockSpan.finish.mockImplementation(() => {
      throw new Error('finish boom');
    });
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => 'app-result')
    );
    let result: unknown;
    expect(() => {
      result = ipcMain._wrapped['handle:ping']({});
    }).not.toThrow();
    expect(result).toBe('app-result');
  });

  it('still propagates the app error when an SDK hook throws on the throw path', async () => {
    // The app handler error must still surface even if tagging the span fails.
    mockSpan.setTag.mockImplementation(() => {
      throw new Error('setTag boom');
    });
    const appErr = new Error('handler boom');
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => {
        throw appErr;
      })
    );
    expect(() => {
      ipcMain._wrapped['handle:ping']({});
    }).toThrow(appErr);
  });

  it('finishes span after promise resolves', async () => {
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    let resolve!: () => void;
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => new Promise<void>((r) => (resolve = r)))
    );
    const result = ipcMain._wrapped['handle:ping']({}) as Promise<unknown>;
    expect(mockSpan.finish).not.toHaveBeenCalled();
    resolve();
    await result;
    await Promise.resolve();
    expect(mockSpan.finish).toHaveBeenCalled();
  });

  it('finishes span with error tag after promise rejects', async () => {
    const { patchIpcMain } = await import('./ipc');
    const err = new Error('async boom');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)(
      'ping',
      vi.fn(() => Promise.reject(err))
    );
    await (ipcMain._wrapped['handle:ping']({}) as Promise<unknown>).catch(() => null);
    await Promise.resolve();
    expect(mockSpan.setTag).toHaveBeenCalledWith('error', err);
    expect(mockSpan.finish).toHaveBeenCalled();
  });

  it('does not extract a carrier from the payload and passes all arguments through untouched', async () => {
    // A last argument that looks like a trace carrier belongs to the app: the SDK does not inject
    // one into IPC, so it must not be extracted or stripped from the handler arguments.
    const handler = vi.fn();
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    (ipcMain.handle as unknown as AnyFn)('ping', handler);
    const carrierLike = { 'x-datadog-trace-id': '123' };
    ipcMain._wrapped['handle:ping']({}, 'payload', carrierLike);
    expect(mockDdTrace.extract).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith({}, 'payload', carrierLike);
  });

  it('parents the consumer span to the active scope', async () => {
    const activeSpan = { id: 'active' };
    mockScope.active.mockReturnValue(activeSpan);
    const ipcMain = await setup();
    ipcMain._wrapped['handle:ping']({});
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ childOf: activeSpan })
    );
    mockScope.active.mockReturnValue(null);
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
    // rejection while finishing the span would silently drop the app's error reporting.
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeRealIpcMain();
    patchIpcMain(ipcMain);

    // vi.fn records the promises returned through it, which marks their rejection as handled. Swap in
    // a plain scope.activate so the wrapper's returned promise is genuinely unhandled, matching real
    // dd-trace behavior; restore the spy afterwards.
    const originalActivate = mockScope.activate;
    mockScope.activate = ((_: unknown, fn: () => unknown) => fn()) as unknown as typeof mockScope.activate;

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
      mockScope.activate = originalActivate;
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

  it('emits exactly one receive span for a once() listener (no double-wrap) (real EventEmitter)', async () => {
    // Node's once() is implemented via this.on(); since `on` is patched, patching `once` to delegate
    // through it would wrap the listener twice and emit nested duplicate spans. The SDK registers the
    // once wrapper via the raw addListener instead, so exactly one span is produced.
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeRealIpcMain();
    patchIpcMain(ipcMain);

    const cb = vi.fn();
    ipcMain.once('foo', cb);
    ipcMain.emit('foo', {});

    expect(cb).toHaveBeenCalledTimes(1);
    expect(mockDdTrace.startSpan).toHaveBeenCalledTimes(1);
    // once fired: auto-removed, so nothing remains.
    expect(ipcMain.listenerCount('foo')).toBe(0);
    ipcMain.emit('foo', {});
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
    // listener twice → nested duplicate electron.main.handle spans. handleOnce is left unpatched so it
    // delegates to the patched handle, producing exactly one span. Mocks with independent methods
    // cannot model this delegation, so this uses a fake that mirrors Electron's implementation.
    const { patchIpcMain } = await import('./ipc');
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
    handlers['ping']({});

    expect(mockDdTrace.startSpan).toHaveBeenCalledTimes(1);
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith('electron.main.handle', expect.anything());
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
    vi.clearAllMocks();
    // clearAllMocks resets call history but not implementations; restore the span mock defaults so
    // resilience tests that make setTag/finish throw do not leak into later tests.
    mockSpan.setTag.mockReset();
    mockSpan.finish.mockReset();
    mockScope.active.mockReturnValue(null);
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
    const { patchWebContents } = await import('./ipc');
    const wc = makeMockWebContents();
    const sendSpy = wc.send;
    const sendToFrameSpy = wc.sendToFrame;
    const BrowserWindow = makeMockBrowserWindow(wc);
    patchWebContents(BrowserWindow);
    const instance = Object.create(BrowserWindow.prototype) as {
      webContents: ReturnType<typeof makeMockWebContents>;
    };
    return { wc, instance, BrowserWindow, sendSpy, sendToFrameSpy };
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

  it.each(sendMethods)('creates a producer span for webContents.$name', async ({ invoke }) => {
    const result = await setup();
    invoke(result);
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'electron.main.send',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tags: expect.objectContaining({
          'span.kind': 'producer',
          'span.type': 'worker',
          component: 'electron',
          'resource.name': 'my-channel',
        }),
      })
    );
    expect(mockSpan.finish).toHaveBeenCalled();
  });

  it('does not append an extra carrier argument for webContents.send', async () => {
    const result = await setup();
    result.instance.webContents.send('my-channel', 'arg1');
    expect(result.sendSpy).toHaveBeenCalledWith('my-channel', 'arg1');
    expect(result.sendSpy.mock.calls[0]).toEqual(['my-channel', 'arg1']);
  });

  it('does not append an extra carrier argument for webContents.sendToFrame', async () => {
    const result = await setup();
    result.instance.webContents.sendToFrame(1, 'my-channel', 'arg1');
    expect(result.sendToFrameSpy).toHaveBeenCalledWith(1, 'my-channel', 'arg1');
    expect(result.sendToFrameSpy.mock.calls[0]).toEqual([1, 'my-channel', 'arg1']);
  });

  it.each(sendMethods)('parents the producer span to the active scope for webContents.$name', async ({ invoke }) => {
    const activeSpan = { id: 'active-handle-span' };
    mockScope.active.mockReturnValue(activeSpan);
    const result = await setup();
    invoke(result);
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'electron.main.send',
      expect.objectContaining({ childOf: activeSpan })
    );
  });

  it.each(sendMethods)(
    'skips instrumentation for datadog: prefixed channels in $name',
    async ({ invokeDatadog, getSpy, datadogArgs }) => {
      const result = await setup();
      invokeDatadog(result);
      expect(mockDdTrace.startSpan).not.toHaveBeenCalled();
      expect(getSpy(result)).toHaveBeenCalledWith(...datadogArgs);
    }
  );

  it.each(sendMethods)(
    'sets span error tag and finishes when underlying $name throws synchronously',
    async ({ getSpy, invoke }) => {
      const err = new Error('send boom');
      const result = await setup();
      getSpy(result).mockImplementation(() => {
        throw err;
      });
      expect(() => invoke(result)).toThrow(err);
      expect(mockSpan.setTag).toHaveBeenCalledWith('error', err);
      expect(mockSpan.finish).toHaveBeenCalledTimes(1);
    }
  );

  it('does not throw and still calls the original when an SDK hook throws (finish throws)', async () => {
    // A tracing failure in the producer span must not break webContents.send.
    mockSpan.finish.mockImplementation(() => {
      throw new Error('finish boom');
    });
    const result = await setup();
    expect(() => {
      result.instance.webContents.send('my-channel', 'arg1');
    }).not.toThrow();
    expect(result.sendSpy).toHaveBeenCalledWith('my-channel', 'arg1');
  });

  it('patches the parent prototype when BrowserWindow is a subclass without own webContents getter', async () => {
    // Simulates the DatadogBrowserWindow scenario: patchBrowserWindow creates a subclass
    // and patchWebContents receives the subclass. The getter lives on the parent prototype.
    const { patchWebContents } = await import('./ipc');
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
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith('electron.main.send', expect.any(Object));
  });

  it('only wraps webContents once when accessed multiple times', async () => {
    const { instance } = await setup();
    instance.webContents.send('ch', 'a');
    vi.clearAllMocks();
    instance.webContents.send('ch', 'b');
    expect(mockDdTrace.startSpan).toHaveBeenCalledTimes(1);
  });
});
