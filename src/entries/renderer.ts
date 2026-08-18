/**
 * Renderer entry point — a `RumPlugin` that wires the SDK's preload-exposed IPC resource bridge to
 * `datadogRum`, without this package depending on `@datadog/browser-rum`/`@datadog/browser-rum-core`.
 *
 * Usage:
 *   import { datadogRum } from '@datadog/browser-rum';
 *   import { datadogRendererPlugin } from '@datadog/electron-sdk/renderer';
 *
 *   datadogRum.init({ ..., plugins: [datadogRendererPlugin()] });
 */
export { datadogRendererPlugin } from '../renderer/datadogRendererPlugin';
export type { DatadogRendererPlugin, IpcRumResourceApi } from '../renderer/datadogRendererPlugin';
