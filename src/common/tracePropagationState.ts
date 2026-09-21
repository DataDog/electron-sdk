// Instrumentation and init() run in separate bundles. Share the live decision rather than a
// copied consent value so reentrant consent changes are visible immediately to both bundles.
const TRACE_PROPAGATION_CHECK = Symbol.for('@datadog/electron-sdk:tracePropagationCheck');

type PropagationStore = Record<symbol, (() => boolean) | undefined>;

/** Whether SDK trace headers may leave the process. Disabled until tracing is configured. */
export function isTracePropagationAllowed(): boolean {
  return (globalThis as unknown as PropagationStore)[TRACE_PROPAGATION_CHECK]?.() ?? false;
}

/** Publish the sampling and consent check used by all HTTP instrumentation. */
export function setTracePropagationCheck(check: () => boolean): void {
  (globalThis as unknown as PropagationStore)[TRACE_PROPAGATION_CHECK] = check;
}
