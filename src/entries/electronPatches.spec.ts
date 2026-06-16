import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow as BrowserWindowType } from 'electron';

vi.mock('dd-trace', () => {
  const span = {
    setTag: vi.fn(),
    finish: vi.fn(),
  };
  const scope = {
    activate: vi.fn((_, fn: () => unknown) => fn()),
  };
  return {
    default: {
      startSpan: vi.fn(() => span),
      extract: vi.fn(() => null),
      inject: vi.fn(),
      scope: vi.fn(() => scope),
    },
  };
});

describe('resolvePreloadPath', () => {
  it('returns the resolved path for the SDK preload', async () => {
    const resolvedPath = '/node_modules/@datadog/electron-sdk/dist/electron/preload.js';
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath(() => resolvedPath);
    expect(result).toBe(resolvedPath);
  });

  it('returns undefined and warns when the package cannot be resolved', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath(() => {
      throw new Error('MODULE_NOT_FOUND');
    });
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[datadog]'));
    warnSpy.mockRestore();
  });
});

describe('patchBrowserWindow', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the preload script on each new BrowserWindow session', async () => {
    const registerPreloadScript = vi.fn();
    const mockSession = { registerPreloadScript };
    const mockWebContents = { session: mockSession };

    class FakeBrowserWindow {
      webContents = mockWebContents;
      constructor() {
        return this;
      }
    }

    const mockElectron = {
      BrowserWindow: FakeBrowserWindow as unknown as typeof BrowserWindowType,
    };

    const { patchBrowserWindow } = await import('./electronPatches');
    patchBrowserWindow(mockElectron as typeof import('electron'), '/tmp/preload.js');

    const PatchedClass = mockElectron.BrowserWindow as unknown as new (o: unknown) => {
      webContents: typeof mockWebContents;
    };
    new PatchedClass({ width: 800 });

    expect(registerPreloadScript).toHaveBeenCalledWith({
      type: 'frame',
      filePath: '/tmp/preload.js',
    });
  });
});

describe('patchIpcMain', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('wraps ipcMain.handle so the original handler is called with a span active', async () => {
    let capturedWrapped: ((...args: unknown[]) => unknown) | null = null;
    const mockIpcMain = {
      handle: vi.fn((_ch: string, listener: (...args: unknown[]) => unknown) => {
        capturedWrapped = listener;
      }),
      handleOnce: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      addListener: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn(),
      emit: vi.fn(),
    };

    const { patchIpcMain } = await import('./electronPatches');
    patchIpcMain(mockIpcMain as unknown as Electron.IpcMain);

    const userFn = vi.fn().mockResolvedValue('result');
    mockIpcMain.handle('test-channel', userFn);

    expect(capturedWrapped).not.toBeNull();

    await capturedWrapped!({} /* event */, 'arg1');

    expect(userFn).toHaveBeenCalledWith({}, 'arg1');
  });

  it('skips tracing for datadog: channels', async () => {
    const ddTrace = (await import('dd-trace')).default;
    let capturedWrapped: ((...args: unknown[]) => unknown) | null = null;
    const mockIpcMain = {
      handle: vi.fn(),
      handleOnce: vi.fn(),
      on: vi.fn((_ch: string, listener: (...args: unknown[]) => unknown) => {
        capturedWrapped = listener;
      }),
      once: vi.fn(),
      addListener: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn(),
      emit: vi.fn(),
    };

    const { patchIpcMain } = await import('./electronPatches');
    patchIpcMain(mockIpcMain as unknown as Electron.IpcMain);

    const userFn = vi.fn();
    mockIpcMain.on('datadog:apm:test', userFn);

    capturedWrapped!({} /* event */);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(ddTrace).startSpan).not.toHaveBeenCalled();
    expect(userFn).toHaveBeenCalled();
  });
});

describe('patchIpcRenderer', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('wraps ipcRenderer.send to create a producer span', async () => {
    const ddTrace = (await import('dd-trace')).default;
    const mockIpcRenderer = {
      send: vi.fn(),
      sendSync: vi.fn(),
      invoke: vi.fn(),
      sendToHost: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      addListener: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    const { patchIpcRenderer } = await import('./electronPatches');
    patchIpcRenderer(mockIpcRenderer as unknown as Electron.IpcRenderer);

    mockIpcRenderer.send('my-channel', 'data');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(ddTrace).startSpan).toHaveBeenCalledWith(
      'electron.renderer.send',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ tags: expect.objectContaining({ 'resource.name': 'my-channel' }) })
    );
  });

  it('wraps ipcRenderer.invoke and finishes span when promise resolves', async () => {
    const ddTrace = (await import('dd-trace')).default;
    const mockIpcRenderer = {
      send: vi.fn(),
      sendSync: vi.fn(),
      invoke: vi.fn().mockResolvedValue('result'),
      sendToHost: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      addListener: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    const { patchIpcRenderer } = await import('./electronPatches');
    patchIpcRenderer(mockIpcRenderer as unknown as Electron.IpcRenderer);

    await mockIpcRenderer.invoke('invoke-channel');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(ddTrace).startSpan).toHaveBeenCalledWith(
      'electron.renderer.send',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ tags: expect.objectContaining({ 'resource.name': 'invoke-channel' }) })
    );
  });
});
