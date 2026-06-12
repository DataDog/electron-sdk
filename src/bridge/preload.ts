'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

declare const location: { hostname: string };
declare const window: Record<string, unknown>;

const BRIDGE_CHANNEL = 'datadog:bridge-send';
const CONFIG_CHANNEL = 'datadog:bridge-config';

const MASK = 'mask';

interface BridgeConfig {
  defaultPrivacyLevel?: string;
  allowedWebViewHosts?: string[];
}

const config = ipcRenderer.sendSync(CONFIG_CHANNEL) as BridgeConfig | null;

const defaultPrivacyLevel = config?.defaultPrivacyLevel ?? MASK;
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

window.DatadogEventBridge = bridge;

try {
  contextBridge.exposeInMainWorld('DatadogEventBridge', bridge);
} catch {
  // exposeInMainWorld throws when contextIsolation is disabled
}
