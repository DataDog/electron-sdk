/// <reference types="vitest/globals" />
/// <reference lib="dom" />

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ResourceHandler } from '../domain/tracing/ipcResourceBridgeTypes';
import { wireIpcResourceBridge } from './wireIpcResourceBridge';

afterEach(() => {
  delete (window as { DatadogIpcBridge?: unknown }).DatadogIpcBridge;
});

describe('wireIpcResourceBridge', () => {
  it('registers a handler on window.DatadogIpcBridge that forwards start/stop events to the given RUM API', () => {
    let registeredHandler: ResourceHandler | undefined;
    window.DatadogIpcBridge = {
      registerResourceHandler: (handler) => {
        registeredHandler = handler;
      },
    };

    const rum = { startResource: vi.fn(), stopResource: vi.fn() };
    wireIpcResourceBridge(rum);

    registeredHandler!({ action: 'start', url: 'ipc-demo:get-profile' });
    expect(rum.startResource).toHaveBeenCalledWith('ipc-demo:get-profile', { type: 'native' });

    registeredHandler!({
      action: 'stop',
      url: 'ipc-demo:get-profile',
      options: { context: { ipc: { role: 'source', id: 'call-abc', method: 'invoke' } } },
    });
    expect(rum.stopResource).toHaveBeenCalledWith('ipc-demo:get-profile', {
      type: 'native',
      context: { ipc: { role: 'source', id: 'call-abc', method: 'invoke' } },
    });
  });

  it('does nothing (no throw) when window.DatadogIpcBridge is not present', () => {
    delete (window as { DatadogIpcBridge?: unknown }).DatadogIpcBridge;
    const rum = { startResource: vi.fn(), stopResource: vi.fn() };

    expect(() => wireIpcResourceBridge(rum)).not.toThrow();
    expect(rum.startResource).not.toHaveBeenCalled();
  });
});
