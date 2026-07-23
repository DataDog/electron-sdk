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
    // Advertise supported capabilities by default to signal support for windows loaded before init().
    // init() replaces this with the config-derived value; that narrowing is only an optimization to
    // save renderer work, since the Electron SDK config (not the advertised capability) governs what
    // is actually sent to Datadog.
    //
    // 'records' is deliberately excluded from this fallback: unlike profiling, replay recording
    // captures DOM data and depends on the real defaultPrivacyLevel and sampling decision, neither of
    // which is known before init(). Advertising it here would start the renderer recording (and
    // streaming records over IPC) for a session that may not even have replay enabled. It is added
    // once setBridgeConfig() publishes the real options.
    holder = {
      value: { defaultPrivacyLevel: 'mask', allowedWebViewHosts: [], capabilities: ['profiles'] },
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
  return { ...value, allowedWebViewHosts: [...value.allowedWebViewHosts], capabilities: [...value.capabilities] };
}

/** Replaces the bridge config the responder returns. Called by init() once the real config is known. */
export function setBridgeConfig(config: BridgeOptions): void {
  getHolder().value = config;
}
