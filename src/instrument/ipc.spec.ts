import { describe, it, expect, vi, beforeEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

const mockSpan = { setTag: vi.fn(), finish: vi.fn() };
const mockScope = { activate: vi.fn((_, fn: () => unknown) => fn()) };
const mockDdTrace = {
  startSpan: vi.fn(() => mockSpan),
  extract: vi.fn<() => object | null>(() => null),
  inject: vi.fn(),
  scope: vi.fn(() => mockScope),
};

vi.mock('dd-trace', () => ({ default: mockDdTrace }));

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

  it('creates an electron.main.handle consumer span when the listener is invoked', async () => {
    const ipcMain = await setup();
    ipcMain._wrapped['handle:ping']({});
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith(
      'electron.main.handle',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tags: expect.objectContaining({ 'span.kind': 'consumer', component: 'electron', type: 'worker' }),
      })
    );
    expect(mockSpan.finish).toHaveBeenCalled();
  });

  it('creates an electron.main.receive consumer span for on/addListener', async () => {
    const ipcMain = await setup();
    ipcMain._wrapped['on:ping']({});
    expect(mockDdTrace.startSpan).toHaveBeenCalledWith('electron.main.receive', expect.any(Object));
    expect(mockSpan.finish).toHaveBeenCalled();
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

  it('does not create a span for datadog: prefixed channels', async () => {
    const { patchIpcMain } = await import('./ipc');
    const ipcMain = makeMockIpcMain();
    patchIpcMain(ipcMain as unknown as Electron.IpcMain);
    const handler = vi.fn();
    (ipcMain.on as unknown as AnyFn)('datadog:bridge-send', handler);
    // wrapper stores listener in _wrapped; calling it should pass through without span creation
    ipcMain._wrapped['on:datadog:bridge-send']?.({});
    expect(mockDdTrace.startSpan).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
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

  it('removeHandler does not throw', async () => {
    const ipcMain = await setup();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    expect(() => (ipcMain.removeHandler as unknown as AnyFn)('ping')).not.toThrow();
  });
});
