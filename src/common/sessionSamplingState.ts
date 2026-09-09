// The instrument entry and init() are separate bundles, so module-level state is not shared between
// the patched Electron APIs and the SDK domain layer. Store the current session decision globally,
// as bridgeConfig does for the same cross-bundle reason.
const SESSION_SAMPLING_STATE = Symbol.for('@datadog/electron-sdk:sessionSamplingState');

interface SessionSamplingState {
  sampled: boolean;
}

function getState(): SessionSamplingState {
  const store = globalThis as unknown as Record<symbol, SessionSamplingState | undefined>;
  return (store[SESSION_SAMPLING_STATE] ??= { sampled: true });
}

/** Whether the current RUM session is sampled. */
export function isCurrentSessionSampled(): boolean {
  return getState().sampled;
}

/** Update the sampling decision when the current RUM session changes. */
export function setCurrentSessionSampled(sampled: boolean): void {
  getState().sampled = sampled;
}
