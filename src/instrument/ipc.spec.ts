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
    (ipcMain.handleOnce as unknown as AnyFn)('ping', noop);
    (ipcMain.on as unknown as AnyFn)('ping', noop);
    (ipcMain.addListener as unknown as AnyFn)('ping', noop);
    (ipcMain.once as unknown as AnyFn)('ping', noop);
    return ipcMain;
  }

  const listenerMethods = [
    { method: 'on', spanName: 'electron.main.receive' },
    { method: 'addListener', spanName: 'electron.main.receive' },
    { method: 'once', spanName: 'electron.main.receive' },
    { method: 'handle', spanName: 'electron.main.handle' },
    { method: 'handleOnce', spanName: 'electron.main.handle' },
  ] as const;

  it.each(listenerMethods)('creates a $spanName consumer span for $method', async ({ method, spanName }) => {
    const ipcMain = await setup();
    ipcMain._wrapped[`${method}:ping`]({});
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      spanName,
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tags: expect.objectContaining({ 'span.kind': 'consumer', component: 'electron', 'span.type': 'worker' }),
      })
    );
    expect(mockSpan.finish).toHaveBeenCalled();
  });

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

  it('extracts childOf from last argument when it is a carrier object', async () => {
    const carrier = { 'x-datadog-trace-id': '123' };
    mockDdTrace.extract.mockReturnValue({ traceId: '123' });
    const ipcMain = await setup();
    ipcMain._wrapped['handle:ping']({}, 'payload', carrier);
    expect(mockDdTrace.extract).toHaveBeenCalledWith('text_map', carrier);
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        childOf: expect.objectContaining({ traceId: '123' }),
      })
    );
  });

  it('handles null childOf gracefully: no crash, no parent span', async () => {
    mockDdTrace.extract.mockReturnValue(null);
    const ipcMain = await setup();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    expect(() => ipcMain._wrapped['handle:ping']({}, 'payload')).not.toThrow();
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        childOf: undefined,
      })
    );
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
