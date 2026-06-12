import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { tracingChannel } from 'node:diagnostics_channel';

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
      constructor(_options: unknown) {
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
  });

  it('wraps ipcMain.handle so user handlers fire mainHandleCh', async () => {
    const events: string[] = [];
    const ch = tracingChannel('apm:electron:ipc:main:handle');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const subscriber = (ctx: any) => events.push(ctx.channel as string);
    ch.start.subscribe(subscriber);

    // Capture the wrapped listener that gets passed to the original handle
    let capturedWrapped: ((...args: unknown[]) => unknown) | null = null;
    const mockIpcMain = {
      handle: vi.fn((_ch: string, listener: (...args: unknown[]) => unknown) => {
        capturedWrapped = listener;
      }),
      handleOnce: vi.fn(),
      on: vi.fn(),
      once: vi.fn((_ch: string, fn: (...args: unknown[]) => unknown) => fn({} as Electron.IpcMainEvent)),
      addListener: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn(),
      emit: vi.fn(),
    };

    const { patchIpcMain } = await import('./electronPatches');
    patchIpcMain(mockIpcMain as unknown as Electron.IpcMain);

    // User code registers a handler after patching
    const userFn = vi.fn();
    mockIpcMain.handle('test-channel', userFn);

    // The original handle spy was called with a WRAPPED version of userFn
    expect(capturedWrapped).not.toBeNull();

    // Simulate Electron invoking the wrapped listener
    await capturedWrapped!({} /* event */, 'arg1');
    expect(events).toContain('test-channel');

    ch.start.unsubscribe(subscriber);
  });
});

describe('patchIpcRenderer', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('wraps ipcRenderer.send so calls publish to rendererSendCh', async () => {
    const events: string[] = [];
    const ch = tracingChannel('apm:electron:ipc:renderer:send');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const subscriber = (ctx: any) => events.push(ctx.channel as string);
    ch.start.subscribe(subscriber);

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
    expect(events).toContain('my-channel');

    ch.start.unsubscribe(subscriber);
  });

  it('wraps ipcRenderer.invoke as a promise so calls publish to rendererSendCh', async () => {
    const events: string[] = [];
    const ch = tracingChannel('apm:electron:ipc:renderer:send');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const subscriber = (ctx: any) => events.push(ctx.channel as string);
    ch.start.subscribe(subscriber);

    const mockIpcRenderer = {
      send: vi.fn(),
      sendSync: vi.fn(),
      invoke: vi.fn().mockResolvedValue(undefined),
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
    expect(events).toContain('invoke-channel');

    ch.start.unsubscribe(subscriber);
  });
});
