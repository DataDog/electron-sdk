import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIpcRendererSend, mockIpcRendererSendSync, mockExposeInMainWorld } = vi.hoisted(() => {
  const mockIpcRendererSend = vi.fn();
  const mockIpcRendererSendSync = vi.fn();
  const mockExposeInMainWorld = vi.fn();
  return { mockIpcRendererSend, mockIpcRendererSendSync, mockExposeInMainWorld };
});

vi.mock('electron', () => ({
  ipcRenderer: {
    send: mockIpcRendererSend,
    sendSync: mockIpcRendererSendSync,
  },
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
}));

// Provide globals expected by the bridge module
const mockWindow: Record<string, unknown> = {};
vi.stubGlobal('window', mockWindow);
vi.stubGlobal('location', { hostname: 'localhost' });

describe('setupRendererBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIpcRendererSendSync.mockReturnValue(undefined);
    delete mockWindow.DatadogEventBridge;
  });

  async function loadBridge() {
    // Re-import to run setupRendererBridge fresh
    const { setupRendererBridge } = await import('./bridge');
    setupRendererBridge();
  }

  it('should assign DatadogEventBridge to window', async () => {
    await loadBridge();

    expect(mockWindow.DatadogEventBridge).toBeDefined();
  });

  it('should expose the bridge via contextBridge', async () => {
    await loadBridge();

    expect(mockExposeInMainWorld).toHaveBeenCalledWith('DatadogEventBridge', expect.any(Object));
  });

  it('should not throw when contextBridge.exposeInMainWorld fails', async () => {
    mockExposeInMainWorld.mockImplementation(() => {
      throw new Error('contextIsolation is not enabled');
    });

    await expect(loadBridge()).resolves.not.toThrow();
    expect(mockWindow.DatadogEventBridge).toBeDefined();
  });

  describe('bridge API', () => {
    function getBridge() {
      return mockWindow.DatadogEventBridge as {
        getCapabilities: () => string;
        getPrivacyLevel: () => string;
        getAllowedWebViewHosts: () => string;
        send: (msg: string) => void;
      };
    }

    it('should return capabilities as empty JSON array', async () => {
      await loadBridge();

      expect(getBridge().getCapabilities()).toBe('[]');
    });

    it('should return privacy level as mask by default', async () => {
      await loadBridge();

      expect(getBridge().getPrivacyLevel()).toBe('mask');
    });

    it('should return allowed hosts including the current hostname', async () => {
      await loadBridge();

      expect(JSON.parse(getBridge().getAllowedWebViewHosts())).toEqual(['localhost']);
    });

    it('should forward messages to ipcRenderer on the datadog:bridge-send channel', async () => {
      await loadBridge();

      const msg = JSON.stringify({ eventType: 'rum', event: { type: 'view' } });
      getBridge().send(msg);

      const { BRIDGE_CHANNEL } = await import('../common');
      expect(mockIpcRendererSend).toHaveBeenCalledWith(BRIDGE_CHANNEL, msg);
    });
  });

  describe('bridge config via IPC', () => {
    function getBridge() {
      return mockWindow.DatadogEventBridge as {
        getPrivacyLevel: () => string;
        getAllowedWebViewHosts: () => string;
      };
    }

    it('should fetch config via sendSync on datadog:bridge-config', async () => {
      await loadBridge();

      expect(mockIpcRendererSendSync).toHaveBeenCalledWith('datadog:bridge-config');
    });

    it('should use privacy level from config', async () => {
      mockIpcRendererSendSync.mockReturnValue({ defaultPrivacyLevel: 'allow', allowedWebViewHosts: [] });
      await loadBridge();

      expect(getBridge().getPrivacyLevel()).toBe('allow');
    });

    it('should use allowed hosts from config and include current hostname', async () => {
      mockIpcRendererSendSync.mockReturnValue({ defaultPrivacyLevel: 'mask', allowedWebViewHosts: ['example.com'] });
      await loadBridge();

      expect(JSON.parse(getBridge().getAllowedWebViewHosts())).toEqual(['localhost', 'example.com']);
    });

    it('should fall back to defaults when sendSync returns undefined', async () => {
      mockIpcRendererSendSync.mockReturnValue(undefined);
      await loadBridge();

      expect(getBridge().getPrivacyLevel()).toBe('mask');
      expect(JSON.parse(getBridge().getAllowedWebViewHosts())).toEqual(['localhost']);
    });

    it('should deduplicate hostname when it appears in config hosts', async () => {
      mockIpcRendererSendSync.mockReturnValue({
        defaultPrivacyLevel: 'mask',
        allowedWebViewHosts: ['localhost', 'other.com'],
      });
      await loadBridge();

      expect(JSON.parse(getBridge().getAllowedWebViewHosts())).toEqual(['localhost', 'other.com']);
    });
  });
});
