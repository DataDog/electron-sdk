import { contextBridge, ipcRenderer } from 'electron';
import { DefaultPrivacyLevel } from '@datadog/browser-core';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';

declare const window: Record<string, unknown>;
declare const location: { hostname: string };

/**
 * Expose a DatadogEventBridge to the renderer process.
 *
 * The browser RUM SDK (`@datadog/browser-rum`) auto-detects this bridge and
 * sends all collected events (fetch, XHR, DOM, errors, …) through it
 * instead of posting directly to the Datadog intake.
 *
 * Events arrive as JSON strings with shape `{ eventType, event }` and are
 * forwarded to the main process via IPC for assembly and transport.
 */
export function setupRendererBridge(): void {
  // Guard against double registration — the bridge may already be set up by
  // auto-injection (preload-auto.cjs) or by a previous manual import.
  if (window.DatadogEventBridge) {
    return;
  }

  // ipcRenderer.sendSync is needed so DatadogEventBridge is fully
  // initialized before renderer scripts run, preventing race conditions
  // with scripts (e.g. @datadog/browser-rum) that rely on the bridge.
  const config = ipcRenderer.sendSync(CONFIG_CHANNEL) as
    | { defaultPrivacyLevel?: DefaultPrivacyLevel; allowedWebViewHosts?: string[] }
    | undefined;

  const defaultPrivacyLevel = config?.defaultPrivacyLevel ?? DefaultPrivacyLevel.MASK;
  const configuredHosts = config?.allowedWebViewHosts ?? [];
  const allowedHosts = [...new Set([location.hostname, ...configuredHosts])];

  const bridge = {
    getCapabilities() {
      return '[]';
    },
    getPrivacyLevel() {
      return defaultPrivacyLevel;
    },
    getAllowedWebViewHosts() {
      return JSON.stringify(allowedHosts);
    },
    send(msg: string) {
      ipcRenderer.send(BRIDGE_CHANNEL, msg);
    },
  };

  // Both assignments are needed to support renderers with and without contextIsolation:
  // - window assignment works when contextIsolation is disabled (shared JS context)
  // - exposeInMainWorld works when contextIsolation is enabled (default since Electron 12)
  window.DatadogEventBridge = bridge;

  try {
    contextBridge.exposeInMainWorld('DatadogEventBridge', bridge);
  } catch {
    // exposeInMainWorld throws when contextIsolation is disabled
  }
}
