/**
 * Renderer entry point — wires the SDK's preload-exposed IPC resource bridge to a host app's own
 * `datadogRum` instance, without this package depending on `@datadog/browser-rum`.
 *
 * Usage:
 *   import { datadogRum } from '@datadog/browser-rum';
 *   import { wireIpcResourceBridge } from '@datadog/electron-sdk/renderer';
 *
 *   datadogRum.init({ ... });
 *   wireIpcResourceBridge(datadogRum);
 */
export { wireIpcResourceBridge } from '../renderer/wireIpcResourceBridge';
export type { IpcRumResourceApi } from '../renderer/wireIpcResourceBridge';
