import type { ResourceHandlerEvent } from '../domain/tracing/ipcResourceBridgeTypes';

declare global {
  interface Window {
    DatadogIpcBridge?: {
      registerResourceHandler: (handler: (event: ResourceHandlerEvent) => void) => void;
    };
  }
}

/**
 * A structural subset of `@datadog/browser-rum`'s public `startResource`/`stopResource` API. Defined
 * locally (rather than importing `@datadog/browser-rum`'s real types) so this package has no runtime
 * or type dependency on browser-rum. `options` is loosened to `Record<string, unknown>` rather than
 * browser-rum's real `ResourceOptions`/`ResourceStopOptions`, whose `type` field is a closed enum with
 * no `'native'` member (see IpcResourceCollector's correction note) — the real `datadogRum` object is
 * still structurally assignable to this interface.
 */
export interface IpcRumResourceApi {
  startResource(url: string, options?: Record<string, unknown>): void;
  stopResource(url: string, options?: Record<string, unknown>): void;
}

/**
 * A structural subset of `@datadog/browser-rum-core`'s real `RumPlugin` interface (`plugins.ts`,
 * itself marked `@experimental`/unstable). Redeclared locally, rather than imported, so this package
 * has no dependency on browser-rum-core. Only the `onInit` hook is used, and its `publicApi` parameter
 * is narrowed to `IpcRumResourceApi` — the two stable public methods this plugin needs — instead of
 * the full `RumPublicApi` surface, which we have no reason to depend on here.
 */
export interface DatadogRendererPlugin {
  name: string;
  onInit?(options: { publicApi: IpcRumResourceApi }): void;
}

/**
 * A `RumPlugin` that connects the SDK's preload-exposed `window.DatadogIpcBridge` (see
 * `src/preload/ipc.ts`) to `datadogRum`, so IPC resource events reach RUM without every app needing to
 * hand-write this wiring. Register it via `datadogRum.init({ ..., plugins: [datadogRendererPlugin()] })`.
 *
 * A no-op if `window.DatadogIpcBridge` isn't present (e.g. `contextIsolation` disabled, or this SDK's
 * preload script wasn't loaded).
 */
export function datadogRendererPlugin(): DatadogRendererPlugin {
  return {
    name: 'electron-ipc-bridge',
    onInit({ publicApi }) {
      window.DatadogIpcBridge?.registerResourceHandler((event) => {
        if (event.action === 'start') {
          publicApi.startResource(event.url, { type: 'native' });
        } else {
          publicApi.stopResource(event.url, { type: 'native', context: event.options?.context });
        }
      });
    },
  };
}
