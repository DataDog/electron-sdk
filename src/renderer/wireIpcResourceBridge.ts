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
 * or type dependency on browser-rum — the host app provides its own already-initialized `datadogRum`
 * instance. `options` is loosened to `Record<string, unknown>` rather than browser-rum's real
 * `ResourceOptions`/`ResourceStopOptions`, whose `type` field is a closed enum with no `'native'`
 * member (see IpcResourceCollector's correction note) — the real `datadogRum` object is still
 * structurally assignable to this interface.
 */
export interface IpcRumResourceApi {
  startResource(url: string, options?: Record<string, unknown>): void;
  stopResource(url: string, options?: Record<string, unknown>): void;
}

/**
 * Connects the SDK's preload-exposed `window.DatadogIpcBridge` (see `src/preload/ipc.ts`) to a host
 * app's own `datadogRum` instance, so IPC resource events reach RUM without every app needing to
 * hand-write this wiring. Call once, in the renderer, after `datadogRum.init(...)`.
 *
 * A no-op if `window.DatadogIpcBridge` isn't present (e.g. `contextIsolation` disabled, or this SDK's
 * preload script wasn't loaded).
 */
export function wireIpcResourceBridge(rum: IpcRumResourceApi): void {
  window.DatadogIpcBridge?.registerResourceHandler((event) => {
    if (event.action === 'start') {
      rum.startResource(event.url, { type: 'native' });
    } else {
      rum.stopResource(event.url, { type: 'native', context: event.options?.context });
    }
  });
}
