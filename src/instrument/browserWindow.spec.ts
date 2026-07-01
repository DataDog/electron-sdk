import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { display } from '../tools/display';

vi.mock('dd-trace', () => ({ default: {} }));
vi.mock('../tools/display', () => ({
  display: { warn: vi.fn() },
}));

describe('resolvePreloadPath', () => {
  it('returns the resolved path when the package can be resolved', async () => {
    const { resolvePreloadPath } = await import('./browserWindow');
    const result = resolvePreloadPath(() => '/node_modules/@datadog/electron-sdk/dist/preload.js');
    expect(result).toBe('/node_modules/@datadog/electron-sdk/dist/preload.js');
  });

  it('returns undefined and warns when the package cannot be resolved', async () => {
    const { resolvePreloadPath } = await import('./browserWindow');
    const result = resolvePreloadPath(() => {
      throw new Error('MODULE_NOT_FOUND');
    });
    expect(result).toBeUndefined();
    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining('Could not resolve preload script'));
  });
});

describe('patchBrowserWindow', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  interface FakeSession {
    registerPreloadScript: ReturnType<typeof vi.fn>;
  }

  function makeMockElectron(defaultRegister = vi.fn()) {
    const readyListeners: (() => void)[] = [];
    const sessionCreatedListeners: ((session: FakeSession) => void)[] = [];
    let ready = false;
    const defaultSession: FakeSession = { registerPreloadScript: defaultRegister };
    return {
      app: {
        isReady: () => ready,
        once: vi.fn((event: string, cb: () => void) => {
          if (event === 'ready') readyListeners.push(cb);
        }),
        on: vi.fn((event: string, cb: (session: FakeSession) => void) => {
          if (event === 'session-created') sessionCreatedListeners.push(cb);
        }),
      },
      session: {
        defaultSession,
      },
      _setReady: (value: boolean): void => {
        ready = value;
      },
      _triggerReady: () => readyListeners.forEach((cb) => cb()),
      _createSession: (session: FakeSession) => sessionCreatedListeners.forEach((cb) => cb(session)),
    };
  }

  it('registers the preload on the default session once the app is ready', async () => {
    const defaultRegister = vi.fn();
    const mockElectron = makeMockElectron(defaultRegister);

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');

    // Nothing registered until the app is ready (the default session may not exist yet).
    expect(defaultRegister).not.toHaveBeenCalled();

    mockElectron._triggerReady();

    expect(defaultRegister).toHaveBeenCalledWith({ type: 'frame', filePath: '/tmp/preload.js' });
    expect(defaultRegister).toHaveBeenCalledTimes(1);
  });

  it('registers the default session immediately when the app is already ready', async () => {
    const defaultRegister = vi.fn();
    const mockElectron = makeMockElectron(defaultRegister);
    mockElectron._setReady(true);

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');

    expect(defaultRegister).toHaveBeenCalledTimes(1);
  });

  it('registers the preload on each custom session as it is created', async () => {
    const mockElectron = makeMockElectron();

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');

    const customRegister = vi.fn();
    mockElectron._createSession({ registerPreloadScript: customRegister });

    // Custom sessions are covered via 'session-created', independent of how the app constructs its
    // BrowserWindow (which may hold the original, unpatched class under ESM).
    expect(customRegister).toHaveBeenCalledWith({ type: 'frame', filePath: '/tmp/preload.js' });
    expect(customRegister).toHaveBeenCalledTimes(1);
  });

  it('registers a given session at most once', async () => {
    const mockElectron = makeMockElectron();

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');

    const register = vi.fn();
    const session = { registerPreloadScript: register };
    mockElectron._createSession(session);
    mockElectron._createSession(session);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it('does not double-register the default session when it is also emitted via session-created', async () => {
    const defaultRegister = vi.fn();
    const mockElectron = makeMockElectron(defaultRegister);

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');

    // The default session is emitted via session-created and also registered explicitly on ready.
    mockElectron._createSession(mockElectron.session.defaultSession);
    mockElectron._triggerReady();

    expect(defaultRegister).toHaveBeenCalledTimes(1);
  });

  it('does not throw when registerPreloadScript fails (reported as telemetry, swallowed)', async () => {
    // A registration failure must be swallowed so app/window setup is unaffected.
    const failingRegister = vi.fn(() => {
      throw new Error('session not available');
    });
    const mockElectron = makeMockElectron(failingRegister);

    const { patchBrowserWindow } = await import('./browserWindow');
    patchBrowserWindow(mockElectron as unknown as typeof import('electron'), '/tmp/preload.js');

    expect(() => mockElectron._triggerReady()).not.toThrow();
    expect(() => mockElectron._createSession({ registerPreloadScript: failingRegister })).not.toThrow();
  });
});
