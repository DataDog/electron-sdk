import { createRequire } from 'node:module';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

function resolvePackage(id: string): string {
  return _require.resolve(id);
}

export function resolvePreloadPath(_resolvePackage = resolvePackage): string | undefined {
  try {
    return _resolvePackage('@datadog/electron-sdk/electron/preload');
  } catch {
    // Package-relative resolution fails when instrument.cjs is loaded via a symlink (e.g. Yarn
    // portal) and the symlink target is resolved to the real path before module lookups start.
    // Fall back to a path co-located with this file — preload.js is always bundled alongside
    // instrument.cjs in the same dist/ directory.
    try {
      return _resolvePackage('./preload');
    } catch {
      console.warn('[datadog] Could not resolve preload script - BrowserWindow injection skipped');
      return undefined;
    }
  }
}

interface NativeBrowserWindow {
  webContents: { session: Electron.Session };
}

export function patchBrowserWindow(electron: typeof import('electron'), preloadPath: string): void {
  // registerPreloadScript is cumulative and session-wide: each call adds another registration
  // rather than replacing. Track sessions we have already registered so a given session gets the
  // preload registered at most once, regardless of how many windows share it. The WeakSet is
  // scoped to this patch call to match the existing closure style.
  const registeredSessions = new WeakSet<Electron.Session>();

  const registerOn = (session: Electron.Session): void => {
    if (registeredSessions.has(session)) {
      return;
    }
    registeredSessions.add(session);
    try {
      session.registerPreloadScript({ type: 'frame', filePath: preloadPath });
    } catch {
      // ignore: session may not be available
    }
  };

  // Register on the default session first. This is the primary mechanism and is guaranteed to work
  // even when electron.BrowserWindow cannot be replaced (e.g. the property is non-writable, which
  // causes the class-replacement below to throw before reaching this code).
  const register = (): void => {
    registerOn(electron.session.defaultSession);
  };

  if (electron.app.isReady()) {
    register();
  } else {
    electron.app.once('ready', register);
  }

  // Also subclass BrowserWindow so windows using non-default sessions also get the preload.
  // This may silently fail if BrowserWindow is non-writable on this Electron build — that's
  // fine because the session.defaultSession registration above covers the common case.
  const OriginalBrowserWindow = electron.BrowserWindow;

  class DatadogBrowserWindow extends OriginalBrowserWindow {
    constructor(options?: Electron.BrowserWindowConstructorOptions) {
      // BrowserWindow doesn't support true subclassing (native code) - super()
      // returns the native instance, not `this`.
      const win = super(options ?? {}) as unknown as NativeBrowserWindow;
      registerOn(win.webContents.session);
      return win as unknown as DatadogBrowserWindow;
    }
  }

  Object.assign(DatadogBrowserWindow, OriginalBrowserWindow);
  try {
    (electron as { BrowserWindow: unknown }).BrowserWindow = DatadogBrowserWindow;
  } catch {
    // BrowserWindow property is non-writable on this Electron build — the
    // session.defaultSession registration above provides the needed coverage.
  }
}
