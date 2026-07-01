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

  interface FakeSession {
    registerPreloadScript: ReturnType<typeof vi.fn>;
  }

  function makeMockElectron(registerPreloadScript = vi.fn()) {
    const readyListeners: (() => void)[] = [];
    const defaultSession: FakeSession = { registerPreloadScript };
    // nextSession lets each test control which session the next constructed window observes. The
    // FakeBrowserWindow constructor reads it synchronously so the SDK subclass sees it via
    // win.webContents.session inside its own constructor (field init on a subclass would run too
    // late). By default each window gets a fresh session.
    let nextSession: FakeSession = { registerPreloadScript: vi.fn() };
    const useSession = (session: FakeSession): void => {
      nextSession = session;
    };
    return {
      BrowserWindow: class FakeBrowserWindow {
        static getAllWindows = vi.fn(() => []);
        webContents: { session: FakeSession };
        constructor() {
          this.webContents = { session: nextSession };
          return this;
        }
      } as unknown as typeof BrowserWindowType,
      app: {
        isReady: vi.fn(() => false),
        once: vi.fn((_event: string, cb: () => void) => {
          readyListeners.push(cb);
        }),
      },
      session: {
        defaultSession,
      },
      _useSession: useSession,
      _triggerReady: () => readyListeners.forEach((cb) => cb()),
    };
  }

  it('calls registerPreloadScript on a new BrowserWindow instance', async () => {
    const mockElectron = makeMockElectron();

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');
    mockElectron._triggerReady();

    // This window uses a fresh (non-default) session, so the count of 1 reflects the constructor
    // path alone; the on-ready default-session registration lands on a different session object.
    const win = new mockElectron.BrowserWindow({ width: 800 }) as unknown as {
      webContents: { session: { registerPreloadScript: ReturnType<typeof vi.fn> } };
    };

    expect(win.webContents.session.registerPreloadScript).toHaveBeenCalledWith({
      type: 'frame',
      filePath: '/tmp/preload.js',
    });
    expect(win.webContents.session.registerPreloadScript).toHaveBeenCalledTimes(1);
  });

  it('registers only once per session when multiple windows share the same session', async () => {
    const mockElectron = makeMockElectron();

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');
    mockElectron._triggerReady();

    const sharedRegister = vi.fn();
    mockElectron._useSession({ registerPreloadScript: sharedRegister });

    new mockElectron.BrowserWindow();
    new mockElectron.BrowserWindow();
    new mockElectron.BrowserWindow();

    expect(sharedRegister).toHaveBeenCalledTimes(1);
    expect(sharedRegister).toHaveBeenCalledWith({ type: 'frame', filePath: '/tmp/preload.js' });
  });

  it('does not re-register the default session when a window uses it', async () => {
    const defaultRegister = vi.fn();
    const mockElectron = makeMockElectron(defaultRegister);
    const defaultSession = mockElectron.session.defaultSession;

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');
    mockElectron._triggerReady();

    // The on-ready path already registered the default session once.
    expect(defaultRegister).toHaveBeenCalledTimes(1);

    mockElectron._useSession(defaultSession);
    new mockElectron.BrowserWindow();
    new mockElectron.BrowserWindow();

    // Still exactly one registration on the default session: the window reused it.
    expect(defaultRegister).toHaveBeenCalledTimes(1);
  });

  it('registers a distinct custom session exactly once', async () => {
    const mockElectron = makeMockElectron();

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');
    mockElectron._triggerReady();

    const customRegister = vi.fn();
    mockElectron._useSession({ registerPreloadScript: customRegister });

    new mockElectron.BrowserWindow();

    expect(customRegister).toHaveBeenCalledTimes(1);
    expect(customRegister).toHaveBeenCalledWith({ type: 'frame', filePath: '/tmp/preload.js' });
  });

  it('shares one registry across the default and custom session paths', async () => {
    const defaultRegister = vi.fn();
    const mockElectron = makeMockElectron(defaultRegister);
    const defaultSession = mockElectron.session.defaultSession;

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');
    mockElectron._triggerReady();

    // The on-ready path registered the default session once.
    expect(defaultRegister).toHaveBeenCalledTimes(1);

    // A window reusing the default session does not re-register it.
    mockElectron._useSession(defaultSession);
    new mockElectron.BrowserWindow();
    expect(defaultRegister).toHaveBeenCalledTimes(1);

    // A window on a distinct custom session is registered exactly once, without affecting the
    // default session count, proving both paths share the same per-patch registry.
    const customRegister = vi.fn();
    mockElectron._useSession({ registerPreloadScript: customRegister });
    new mockElectron.BrowserWindow();
    expect(customRegister).toHaveBeenCalledTimes(1);
    expect(defaultRegister).toHaveBeenCalledTimes(1);
  });

  it('preserves static properties of the original BrowserWindow', async () => {
    const getAllWindows = vi.fn(() => []);
    const mockElectron = makeMockElectron();
    // Override getAllWindows on the specific class for this test
    (mockElectron.BrowserWindow as unknown as { getAllWindows: typeof getAllWindows }).getAllWindows = getAllWindows;

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');

    expect((mockElectron.BrowserWindow as unknown as { getAllWindows: typeof getAllWindows }).getAllWindows).toBe(
      getAllWindows
    );
  });
});
