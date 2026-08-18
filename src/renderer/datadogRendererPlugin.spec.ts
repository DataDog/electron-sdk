/// <reference types="vitest/globals" />
/// <reference lib="dom" />

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ResourceHandler } from '../domain/tracing/ipcResourceBridgeTypes';
import { datadogRendererPlugin } from './datadogRendererPlugin';

afterEach(() => {
  delete (window as { DatadogIpcBridge?: unknown }).DatadogIpcBridge;
});

describe('datadogRendererPlugin', () => {
  it('exposes the RumPlugin name/onInit shape and forwards start/stop events to the RUM public API', () => {
    let registeredHandler: ResourceHandler | undefined;
    window.DatadogIpcBridge = {
      registerResourceHandler: (handler) => {
        registeredHandler = handler;
      },
    };

    const plugin = datadogRendererPlugin();
    expect(plugin.name).toBe('electron-ipc-bridge');

    const publicApi = { startResource: vi.fn(), stopResource: vi.fn() };
    plugin.onInit!({ publicApi });

    registeredHandler!({ action: 'start', url: 'ipc-demo:get-profile' });
    expect(publicApi.startResource).toHaveBeenCalledWith('ipc-demo:get-profile', { type: 'native' });

    registeredHandler!({
      action: 'stop',
      url: 'ipc-demo:get-profile',
      options: { context: { ipc: { role: 'source', id: 'call-abc', method: 'invoke' } } },
    });
    expect(publicApi.stopResource).toHaveBeenCalledWith('ipc-demo:get-profile', {
      type: 'native',
      context: { ipc: { role: 'source', id: 'call-abc', method: 'invoke' } },
    });
  });

  it('does nothing (no throw) when window.DatadogIpcBridge is not present', () => {
    delete (window as { DatadogIpcBridge?: unknown }).DatadogIpcBridge;
    const publicApi = { startResource: vi.fn(), stopResource: vi.fn() };

    const plugin = datadogRendererPlugin();
    expect(() => plugin.onInit!({ publicApi })).not.toThrow();
    expect(publicApi.startResource).not.toHaveBeenCalled();
  });
});
