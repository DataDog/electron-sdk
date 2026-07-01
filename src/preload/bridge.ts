import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';

declare const location: { hostname: string };
declare const window: Record<string, unknown>;

// Guard against double-execution when the preload is registered more than once on the same session.
// window persists across multiple executions of the same preload within a single frame context.
const DD_BRIDGE_INIT = '__dd_bridge_initialized';

if (!window[DD_BRIDGE_INIT]) {
  window[DD_BRIDGE_INIT] = true;

  interface BridgeConfig {
    defaultPrivacyLevel?: string;
    allowedWebViewHosts?: string[];
  }

  const config = ipcRenderer.sendSync(CONFIG_CHANNEL) as BridgeConfig | null;

  const defaultPrivacyLevel = config?.defaultPrivacyLevel ?? 'mask';
  const configuredHosts = config?.allowedWebViewHosts ?? [];
  const allowedHosts = [...new Set([location.hostname, ...configuredHosts])];

  const bridge = {
    getCapabilities(): string {
      return '[]';
    },
    getPrivacyLevel(): string {
      return defaultPrivacyLevel;
    },
    getAllowedWebViewHosts(): string {
      return JSON.stringify(allowedHosts);
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
