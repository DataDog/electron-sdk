/// <reference types="vitest/globals" />
/// <reference lib="dom" />

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => {
  const sendSync = vi.fn().mockReturnValue(null);
  return {
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: {
      sendSync,
      send: vi.fn(),
    },
  };
});

describe('bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).DatadogEventBridge;
  });

  async function load(config: unknown = null): Promise<typeof import('electron')> {
    const electron = await import('electron');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    (electron.ipcRenderer as any).sendSync.mockReturnValue(config);
    await import('./bridge');
    return electron;
  }

  it('sets window.DatadogEventBridge', async () => {
    await load();
    expect((window as unknown as Record<string, unknown>).DatadogEventBridge).toBeDefined();
  });

  it('getCapabilities returns empty array string', async () => {
    await load();
    const bridge = (window as unknown as Record<string, { getCapabilities(): string }>).DatadogEventBridge;
    expect(bridge.getCapabilities()).toBe('[]');
  });

  it('getPrivacyLevel defaults to mask when config is null', async () => {
    await load(null);
    const bridge = (window as unknown as Record<string, { getPrivacyLevel(): string }>).DatadogEventBridge;
    expect(bridge.getPrivacyLevel()).toBe('mask');
  });

  it('getPrivacyLevel returns configured privacy level', async () => {
    await load({ defaultPrivacyLevel: 'allow' });
    const bridge = (window as unknown as Record<string, { getPrivacyLevel(): string }>).DatadogEventBridge;
    expect(bridge.getPrivacyLevel()).toBe('allow');
  });

  it('getAllowedWebViewHosts includes location.hostname', async () => {
    await load();
    const bridge = (window as unknown as Record<string, { getAllowedWebViewHosts(): string }>).DatadogEventBridge;
    const hosts = JSON.parse(bridge.getAllowedWebViewHosts()) as string[];
    expect(hosts).toContain('localhost'); // jsdom default
  });

  it('getAllowedWebViewHosts includes configured hosts', async () => {
    await load({ allowedWebViewHosts: ['example.com'] });
    const bridge = (window as unknown as Record<string, { getAllowedWebViewHosts(): string }>).DatadogEventBridge;
    const hosts = JSON.parse(bridge.getAllowedWebViewHosts()) as string[];
    expect(hosts).toContain('example.com');
    expect(hosts).toContain('localhost');
  });

  it('send calls ipcRenderer.send with the bridge channel', async () => {
    const electron = await load();
    const bridge = (window as unknown as Record<string, { send(msg: string): void }>).DatadogEventBridge;
    bridge.send('{"type":"rum"}');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('datadog:bridge-send', '{"type":"rum"}');
  });

  it('calls contextBridge.exposeInMainWorld with the bridge object', async () => {
    const electron = await load();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'DatadogEventBridge',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        getCapabilities: expect.any(Function),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        getPrivacyLevel: expect.any(Function),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        getAllowedWebViewHosts: expect.any(Function),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        send: expect.any(Function),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    );
  });

  it('swallows errors from contextBridge.exposeInMainWorld when contextIsolation is disabled', async () => {
    const electron = await import('electron');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    (electron.contextBridge as any).exposeInMainWorld.mockImplementation(() => {
      throw new Error('contextIsolation is disabled');
    });
    await expect(import('./bridge')).resolves.not.toThrow();
  });
});
