import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { tracingChannel } from 'node:diagnostics_channel';

vi.mock('preload-content', () => ({ default: 'const x = 1' }));
vi.mock('node:fs');

describe('resolvePreloadPath', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the embedded content to tmpdir and returns the path', async () => {
    const fs = await import('node:fs');
    const writeSpy = vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath();
    expect(result).toContain(os.tmpdir());
    expect(result).toContain('datadog-preload-');
    expect(writeSpy).toHaveBeenCalledWith(result, 'const x = 1', { flag: 'wx' });
  });

  it('returns the tmp path even when the file already exists (EEXIST)', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      const err = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      throw err;
    });
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath();
    expect(result).toContain('datadog-preload-');
  });

  it('returns undefined and warns when write fails with unexpected error and resolve fails', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath(() => {
      throw new Error('MODULE_NOT_FOUND');
    });
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[datadog]'));
  });

  it('returns the resolved path when write fails but resolve succeeds', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const resolvedPath = '/node_modules/@datadog/electron-sdk/dist/electron/preload.js';
    const { resolvePreloadPath } = await import('./electronPatches');
    const result = resolvePreloadPath(() => resolvedPath);
    expect(result).toBe(resolvedPath);
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
    ch.start.subscribe((ctx: any) => events.push(ctx.channel as string));

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    ch.start.unsubscribe((ctx: any) => events.push(ctx.channel as string));
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
    ch.start.subscribe((ctx: any) => events.push(ctx.channel as string));

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    ch.start.unsubscribe((ctx: any) => events.push(ctx.channel as string));
  });
});
