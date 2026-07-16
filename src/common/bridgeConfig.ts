import type { DefaultPrivacyLevel } from '@datadog/browser-core';

export interface BridgeOptions {
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedWebViewHosts: string[];
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
    // Capabilities advertise which features the bridge supports. Profiling is advertised by default to
    // signal support, consistent with the other Datadog SDKs. init() replaces this with the config value.
    holder = { value: { defaultPrivacyLevel: 'mask', allowedWebViewHosts: [], capabilities: ['profiles'] } };
    store[BRIDGE_CONFIG] = holder;
  }
  return holder;
}

/** Current bridge config. Returns the safe fallback until init() calls setBridgeConfig. */
export function getBridgeConfig(): BridgeOptions {
  // Return a copy (including a fresh array) so callers cannot mutate the shared holder and corrupt
  // subsequent responses.
  const { value } = getHolder();
  return { ...value, allowedWebViewHosts: [...value.allowedWebViewHosts], capabilities: [...value.capabilities] };
}

/** Replaces the bridge config the responder returns. Called by init() once the real config is known. */
export function setBridgeConfig(config: BridgeOptions): void {
  getHolder().value = config;
}
