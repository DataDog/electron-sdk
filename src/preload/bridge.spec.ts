/// <reference types="vitest/globals" />
/// <reference lib="dom" />

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockExposeInMainWorld = vi.fn();
const mockSendSync = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    sendSync: mockSendSync,
    send: mockSend,
  },
}));

describe('bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSendSync.mockReturnValue(null);
    const win = window as unknown as Record<string, unknown>;
    delete win.DatadogEventBridge;
    delete win.__dd_bridge_initialized;
  });

  async function load(config: unknown = null): Promise<void> {
    mockSendSync.mockReturnValue(config);
    await import('./bridge');
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

  it('getAllowedWebViewHosts does NOT include location.hostname by default', async () => {
    await load({ allowedRendererHosts: ['*', ''] });
    const bridge = (window as unknown as Record<string, { getAllowedWebViewHosts(): string }>).DatadogEventBridge;
    const hosts = JSON.parse(bridge.getAllowedWebViewHosts()) as string[];
    // The preload must NOT inject location.hostname — it returns the stored list as-is
    expect(hosts).not.toContain('localhost');
    expect(hosts).toEqual(['*', '']);
  });

  it('getAllowedWebViewHosts returns only configured hosts', async () => {
    await load({ allowedRendererHosts: ['example.com'] });
    const bridge = (window as unknown as Record<string, { getAllowedWebViewHosts(): string }>).DatadogEventBridge;
    const hosts = JSON.parse(bridge.getAllowedWebViewHosts()) as string[];
    expect(hosts).toEqual(['example.com']);
    expect(hosts).not.toContain('localhost');
  });

  it('getAllowedWebViewHosts returns empty array when allowedRendererHosts is []', async () => {
    await load({ allowedRendererHosts: [] });
    const bridge = (window as unknown as Record<string, { getAllowedWebViewHosts(): string }>).DatadogEventBridge;
    const hosts = JSON.parse(bridge.getAllowedWebViewHosts()) as string[];
    expect(hosts).toEqual([]);
  });

  it("getAllowedWebViewHosts returns [''] when allowedRendererHosts is [''] (normalized from 'file://')", async () => {
    await load({ allowedRendererHosts: [''] });
    const bridge = (window as unknown as Record<string, { getAllowedWebViewHosts(): string }>).DatadogEventBridge;
    const hosts = JSON.parse(bridge.getAllowedWebViewHosts()) as string[];
    expect(hosts).toEqual(['']);
  });

  it('send calls ipcRenderer.send with the bridge channel', async () => {
    await load();
    const bridge = (window as unknown as Record<string, { send(msg: string): void }>).DatadogEventBridge;
    bridge.send('{"type":"rum"}');
    expect(mockSend).toHaveBeenCalledWith('datadog:bridge-send', '{"type":"rum"}');
  });

  it('calls contextBridge.exposeInMainWorld with the bridge object', async () => {
    await load();
    expect(mockExposeInMainWorld).toHaveBeenCalledWith(
      'DatadogEventBridge',
      expect.objectContaining({
        getCapabilities: expect.any(Function) as unknown,
        getPrivacyLevel: expect.any(Function) as unknown,
        getAllowedWebViewHosts: expect.any(Function) as unknown,
        send: expect.any(Function) as unknown,
      })
    );
  });

  it('swallows errors from contextBridge.exposeInMainWorld when contextIsolation is disabled', async () => {
    mockExposeInMainWorld.mockImplementation(() => {
      throw new Error('contextIsolation is disabled');
    });
    await expect(import('./bridge')).resolves.not.toThrow();
  });

  it('does not re-initialize when loaded a second time in the same frame', async () => {
    await load({ defaultPrivacyLevel: 'allow' });

    // Simulate a second preload execution: new module instance (vi.resetModules) but the same
    // window state, as would happen when Electron runs the same preload script twice per frame.
    vi.resetModules();
    vi.clearAllMocks();
    mockSendSync.mockReturnValue({ defaultPrivacyLevel: 'mask' });

    await import('./bridge');

    expect(mockSendSync).not.toHaveBeenCalled();
    expect(mockExposeInMainWorld).not.toHaveBeenCalled();
    const bridge = (window as unknown as Record<string, { getPrivacyLevel(): string }>).DatadogEventBridge;
    expect(bridge.getPrivacyLevel()).toBe('allow');
  });
});
