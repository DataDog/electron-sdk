import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';

declare const window: Record<string, unknown>;

// Guard against double-execution when the preload is registered more than once on the same session.
// window persists across multiple executions of the same preload within a single frame context.
const DD_BRIDGE_INIT = '__dd_bridge_initialized';

if (!window[DD_BRIDGE_INIT]) {
  window[DD_BRIDGE_INIT] = true;

  interface BridgeConfig {
    defaultPrivacyLevel?: string;
    allowedRendererHosts?: string[];
    capabilities?: string[];
  }

  const config = ipcRenderer.sendSync(CONFIG_CHANNEL) as BridgeConfig | null;

  const defaultPrivacyLevel = config?.defaultPrivacyLevel ?? 'mask';
  // config is always non-null in production (responder registered at instrument time),
  // but defensive ?? [] keeps unit tests that pass null config working correctly.
  const allowedRendererHosts = config?.allowedRendererHosts ?? [];

  const bridge = {
    getCapabilities(): string {
      return JSON.stringify(config?.capabilities ?? []);
    },
    getPrivacyLevel(): string {
      return defaultPrivacyLevel;
    },
    getAllowedWebViewHosts(): string {
      return JSON.stringify(allowedRendererHosts);
    },
    send(msg: string): void {
      ipcRenderer.send(BRIDGE_CHANNEL, msg);
    },
  };

  window.DatadogEventBridge = bridge;

  try {
    contextBridge.exposeInMainWorld('DatadogEventBridge', bridge);
  } catch {
    // exposeInMainWorld throws when contextIsolation is disabled
  }
}
