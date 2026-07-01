import { createRequire } from 'node:module';
import { callMonitored } from '../domain/telemetry';
import { display } from '../tools/display';

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
      display.warn('Could not resolve preload script - BrowserWindow injection skipped');
      return undefined;
    }
  }
}

export function patchBrowserWindow(electron: typeof import('electron'), preloadPath: string): void {
  // registerPreloadScript is cumulative and session-wide: each call adds another registration
  // rather than replacing. Track sessions we have already registered so a given session gets the
  // preload registered at most once, regardless of how many windows share it.
  const registeredSessions = new WeakSet<Electron.Session>();

  const registerOn = (session: Electron.Session): void => {
    if (registeredSessions.has(session)) {
      return;
    }
    registeredSessions.add(session);
    // A registration failure (e.g. session not available) is reported as telemetry and swallowed;
    // it must never break window creation.
    callMonitored(() => session.registerPreloadScript({ type: 'frame', filePath: preloadPath }));
  };

  // Register on every session as it is created. This is the primary mechanism and covers windows on
  // custom sessions/partitions without depending on the app constructing them through a patched
  // BrowserWindow — a static ESM `import { BrowserWindow } from 'electron'` can capture the original
  // class before instrumentation runs, so patching the export is not reliable. Hooking session
  // creation instead works across CJS/ESM and bundler-plugin vs manual-import setups.
  electron.app.on('session-created', registerOn);

  // The default session is usually created before this runs, so 'session-created' has already fired
  // for it; register it explicitly once the app is ready. The WeakSet keeps this idempotent if the
  // event did fire for it.
  const registerDefault = (): void => registerOn(electron.session.defaultSession);
  if (electron.app.isReady()) {
    registerDefault();
  } else {
    electron.app.once('ready', registerDefault);
  }
}
