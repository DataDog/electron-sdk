import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';

const electronPath = require.resolve('electron');
const preloadPath = resolve(__dirname, './preload.js');

interface BridgeConfig {
  defaultPrivacyLevel: string;
  allowedWebViewHosts: string[];
}

interface DatadogEventBridge {
  getCapabilities: () => string;
  getPrivacyLevel: () => string;
  getAllowedWebViewHosts: () => string;
  send: (msg: string) => void;
}

interface TestGlobal {
  window: { DatadogEventBridge: DatadogEventBridge };
  location: { hostname: string };
}

function injectElectronMock(config: BridgeConfig | null): {
  mockSendSync: ReturnType<typeof vi.fn>;
  mockSend: ReturnType<typeof vi.fn>;
} {
  const mockSendSync = vi.fn(() => config);
  const mockSend = vi.fn();

  // Inject a mock into the require cache so that preload.js (CJS) picks it up.
  // vi.mock() only intercepts ESM imports; require() must be handled via cache.
  (require.cache as Record<string, unknown>)[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      contextBridge: { exposeInMainWorld: vi.fn() },
      ipcRenderer: { sendSync: mockSendSync, send: mockSend },
    },
    parent: null,
    children: [],
    paths: [],
  };

  return { mockSendSync, mockSend };
}

describe('preload bridge script', () => {
  beforeEach(() => {
    // Remove preload from cache so it re-executes and picks up the new electron mock.
    delete require.cache[preloadPath];
    (global as unknown as TestGlobal).window = {} as TestGlobal['window'];
    (global as unknown as TestGlobal).location = { hostname: 'localhost' };
  });

  it('exposes DatadogEventBridge on window', () => {
    injectElectronMock({ defaultPrivacyLevel: 'allow', allowedWebViewHosts: [] });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./preload.js');

    const { DatadogEventBridge: bridge } = (global as unknown as TestGlobal).window;
    expect(bridge).toBeDefined();
    expect(bridge.getPrivacyLevel()).toBe('allow');
    expect(bridge.getCapabilities()).toBe('[]');
  });

  it('send() calls ipcRenderer.send on BRIDGE_CHANNEL', () => {
    const { mockSend } = injectElectronMock(null);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./preload.js');

    const { DatadogEventBridge: bridge } = (global as unknown as TestGlobal).window;
    bridge.send('{"type":"view"}');

    expect(mockSend).toHaveBeenCalledWith('datadog:bridge-send', '{"type":"view"}');
  });

  it('defaults to mask privacy level when config is null', () => {
    injectElectronMock(null);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./preload.js');

    const { DatadogEventBridge: bridge } = (global as unknown as TestGlobal).window;
    expect(bridge.getPrivacyLevel()).toBe('mask');
  });
});
