import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow as BrowserWindowType } from 'electron';

vi.mock('dd-trace', () => ({ default: {} }));

describe('resolvePreloadPath', () => {
  it('returns the resolved path when the package can be resolved', async () => {
    const { resolvePreloadPath } = await import('./browserWindow');
    const result = resolvePreloadPath(() => '/node_modules/@datadog/electron-sdk/dist/preload.js');
    expect(result).toBe('/node_modules/@datadog/electron-sdk/dist/preload.js');
  });

  it('returns undefined and warns when the package cannot be resolved', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    const { resolvePreloadPath } = await import('./browserWindow');
    const result = resolvePreloadPath(() => {
      throw new Error('MODULE_NOT_FOUND');
    });
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[datadog]'));
    warnSpy.mockRestore();
  });
});

describe('patchBrowserWindow', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('calls registerPreloadScript on each new BrowserWindow instance', async () => {
    const registerPreloadScript = vi.fn();

    class FakeBrowserWindow {
      webContents = { session: { registerPreloadScript } };
      constructor() {
        return this;
      }
    }

    const mockElectron = { BrowserWindow: FakeBrowserWindow as unknown as typeof BrowserWindowType };
    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as typeof import('electron'), '/tmp/preload.js');

    new mockElectron.BrowserWindow({ width: 800 });

    expect(registerPreloadScript).toHaveBeenCalledWith({ type: 'frame', filePath: '/tmp/preload.js' });
  });

  it('preserves static properties of the original BrowserWindow', async () => {
    const getAllWindows = vi.fn(() => []);

    class FakeBrowserWindow {
      static getAllWindows = getAllWindows;
      webContents = { session: { registerPreloadScript: vi.fn() } };
      constructor() {
        return this;
      }
    }

    const mockElectron = { BrowserWindow: FakeBrowserWindow as unknown as typeof BrowserWindowType };
    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as typeof import('electron'), '/tmp/preload.js');

    expect((mockElectron.BrowserWindow as unknown as { getAllWindows: typeof getAllWindows }).getAllWindows).toBe(
      getAllWindows
    );
  });
});
