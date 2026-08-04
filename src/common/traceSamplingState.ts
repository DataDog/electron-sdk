// The instrument entry and init() are separate bundles, so module-level state is not shared between
// the patched Electron APIs and the SDK domain layer. Keep the current session decision on a process
// global, as bridgeConfig does for the same cross-bundle reason.
const TRACE_SAMPLING_STATE = Symbol.for('@datadog/electron-sdk:traceSamplingState');

interface TraceSamplingState {
  sampled: boolean;
}

function getState(): TraceSamplingState {
  const store = globalThis as unknown as Record<symbol, TraceSamplingState | undefined>;
  return (store[TRACE_SAMPLING_STATE] ??= { sampled: true });
}

/** Whether newly instrumented operations should create and propagate a trace. */
export function isTraceSampled(): boolean {
  return getState().sampled;
}

/** Update tracing instrumentation for the current RUM session. */
export function setTraceSampled(sampled: boolean): void {
  getState().sampled = sampled;
}
