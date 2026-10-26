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
  value: BridgeOptions | null;
}

function getHolder(): BridgeConfigHolder {
  const store = globalThis as unknown as Record<symbol, BridgeConfigHolder | undefined>;
  return (store[BRIDGE_CONFIG] ??= { value: null });
}

/** Current bridge config, or `null` until init() publishes one. */
export function getBridgeConfig(): BridgeOptions | null {
  const { value } = getHolder();
  if (!value) {
    return null;
  }
  // Return a copy (including fresh arrays) so callers cannot mutate the shared holder and corrupt
  // subsequent responses.
  return { ...value, allowedRendererHosts: [...value.allowedRendererHosts], capabilities: [...value.capabilities] };
}

/** Replaces the bridge config the responder returns. */
export function setBridgeConfig(config: BridgeOptions): void {
  getHolder().value = config;
}
