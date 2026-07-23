import type { DefaultPrivacyLevel } from '@datadog/browser-core';

export interface BridgeOptions {
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedRendererHosts: string[];
  capabilities: string[];
}

// The instrument entry (instrument.cjs/.mjs) and init() (main index bundle) are separate module
// instances, so a module-level variable would not be shared between the responder and the writer.
// Key the holder on a process global so both observe the same value regardless of which bundle set it.
const BRIDGE_CONFIG = Symbol.for('@datadog/electron-sdk:bridgeConfig');

interface BridgeConfigHolder {
  value: BridgeOptions;
}

function getHolder(): BridgeConfigHolder {
  const store = globalThis as unknown as Record<symbol, BridgeConfigHolder | undefined>;
  let holder = store[BRIDGE_CONFIG];
  if (!holder) {
    // Advertise the SDK's supported capabilities by default to signal support. init() replaces this with
    // the config-derived value; that narrowing is only an optimization to save renderer work, since the
    // Electron SDK config (not the advertised capability) governs what is actually sent to Datadog.
    holder = {
      value: {
        defaultPrivacyLevel: 'mask',
        // Pre-normalized equivalent of allowedRendererHosts: ['*']: '*' covers all non-empty hostnames
        // but the Browser SDK's matchesHostEntry requires host.length > 0, so file:// pages
        // (location.hostname === '') would not match. The '' entry covers that gap.
        // TODO: Change to [] once a track-consent API exists. Currently ['*', ''] because customers
        // must open a window to collect user consent before calling init(), which means windows
        // can open before init() runs. A consent API will allow init() to be called immediately
        // with trackingConsent: 'not-granted', eliminating the pre-init window scenario.
        allowedRendererHosts: ['*', ''],
        capabilities: ['profiles'],
      },
    };
    store[BRIDGE_CONFIG] = holder;
  }
  return holder;
}

/** Current bridge config. Returns the safe fallback until init() calls setBridgeConfig. */
export function getBridgeConfig(): BridgeOptions {
  // Return a copy (including a fresh array) so callers cannot mutate the shared holder and corrupt
  // subsequent responses.
  const { value } = getHolder();
  return { ...value, allowedRendererHosts: [...value.allowedRendererHosts], capabilities: [...value.capabilities] };
}

/** Replaces the bridge config the responder returns. Called by init() once the real config is known. */
export function setBridgeConfig(config: BridgeOptions): void {
  getHolder().value = config;
}
