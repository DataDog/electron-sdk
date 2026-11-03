import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL, type BridgeOptions } from '../common';

declare const window: Record<string, unknown>;

// Guard against double-execution when the preload is registered more than once on the same session.
// window persists across multiple executions of the same preload within a single frame context.
const DD_BRIDGE_INIT = '__dd_bridge_initialized';

if (!window[DD_BRIDGE_INIT]) {
  window[DD_BRIDGE_INIT] = true;

  const config = ipcRenderer.sendSync(CONFIG_CHANNEL) as BridgeOptions | null;

  // A page loaded before init() publishes the config gets none: what it collects before this launch's consent and
  // session are recorded can be judged by the previous launch's. It sends nothing until it reloads, but still gets the
  // bridge for every host ('' covers file://), so that its Browser SDK does not run standalone, uploading with its own
  // client token outside the tracking consent.
  const { defaultPrivacyLevel, allowedRendererHosts, capabilities } = config ?? {
    defaultPrivacyLevel: 'mask',
    allowedRendererHosts: ['*', ''],
    capabilities: [],
  };

  const bridge = {
    getCapabilities(): string {
      return JSON.stringify(capabilities);
    },
    getPrivacyLevel(): string {
      return defaultPrivacyLevel;
    },
    getAllowedWebViewHosts(): string {
      return JSON.stringify(allowedRendererHosts);
    },
    send(msg: string): void {
      if (config) {
        ipcRenderer.send(BRIDGE_CHANNEL, msg);
      }
    },
  };

  window.DatadogEventBridge = bridge;

  try {
    contextBridge.exposeInMainWorld('DatadogEventBridge', bridge);
  } catch {
    // exposeInMainWorld throws when contextIsolation is disabled
  }
}
