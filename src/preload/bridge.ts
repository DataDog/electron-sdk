import { contextBridge, ipcRenderer } from 'electron';

declare const location: { hostname: string };
declare const window: Record<string, unknown>;

export const BRIDGE_CHANNEL = 'datadog:bridge-send';
export const CONFIG_CHANNEL = 'datadog:bridge-config';

interface BridgeConfig {
  defaultPrivacyLevel?: string;
  allowedWebViewHosts?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
const config = (ipcRenderer as any).sendSync(CONFIG_CHANNEL) as BridgeConfig | null;

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
