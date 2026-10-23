// The instrument entry and init() are separate bundles, so module-level state is not shared between
// the patched Electron APIs and the SDK domain layer. Store the flag globally, as bridgeConfig does
// for the same cross-bundle reason.
const SESSION_SAMPLING_STATE = Symbol.for('@datadog/electron-sdk:sessionSamplingState');

interface SessionSamplingState {
  sampledSessionActive: boolean;
}

function getState(): SessionSamplingState {
  const store = globalThis as unknown as Record<symbol, SessionSamplingState | undefined>;
  // Nothing propagates before the session manager decides, as the decision depends on sampling and
  // tracking consent.
  return (store[SESSION_SAMPLING_STATE] ??= { sampledSessionActive: false });
}

/** Whether a sampled RUM session is active. */
export function isSampledSessionActive(): boolean {
  return getState().sampledSessionActive;
}

export function setSampledSessionActive(active: boolean): void {
  getState().sampledSessionActive = active;
}
