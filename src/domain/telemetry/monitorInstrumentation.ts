import { callMonitored } from './Telemetry';

interface InstrumentHooks<T> {
  onResult: (cb: (result: T) => void) => void;
  onError: (cb: (err: unknown) => void) => void;
}

/**
 * Wraps a call to an original (Electron/Node) method so that all SDK-side tracing hooks are
 * monitored, while the original's return/throw is preserved exactly.
 *
 * `before` runs monitored and registers optional `onResult`/`onError` hooks (plus any synchronous
 * setup such as starting a span or mutating arguments). `invokeOriginal` runs raw so its return
 * value and thrown errors flow through unchanged. On a synchronous throw the `onError` hook runs
 * monitored and the error is rethrown; on success the `onResult` hook runs monitored with the raw
 * result. All SDK hooks are monitored, so a tracing failure degrades to telemetry and never breaks
 * the wrapped method. If `before` throws before registering hooks, the call quietly no-ops and the
 * original still runs.
 */
export function monitorInstrumentation<T>(before: (hooks: InstrumentHooks<T>) => void, invokeOriginal: () => T): T {
  let onResult: ((result: T) => void) | undefined;
  let onError: ((err: unknown) => void) | undefined;

  callMonitored(() =>
    before({
      onResult: (cb) => (onResult = cb),
      onError: (cb) => (onError = cb),
    })
  );

  let result: T;
  try {
    result = invokeOriginal();
  } catch (err) {
    const handleError = onError;
    if (handleError) callMonitored(() => handleError(err));
    throw err;
  }

  const handleResult = onResult;
  if (handleResult) callMonitored(() => handleResult(result));
  return result;
}
