import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getBridgeConfig, setBridgeConfig } from './bridgeConfig';

describe('bridgeConfig', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:bridgeConfig')];
  });

  it('returns the fallback config before init sets a value', () => {
    expect(getBridgeConfig()).toEqual({
      defaultPrivacyLevel: 'mask',
      allowedWebViewHosts: [],
      capabilities: ['profiles'],
    });
  });

  it('returns the value written by setBridgeConfig', () => {
    setBridgeConfig({ defaultPrivacyLevel: 'allow', allowedWebViewHosts: ['app.example.com'], capabilities: [] });
    expect(getBridgeConfig()).toEqual({
      defaultPrivacyLevel: 'allow',
      allowedWebViewHosts: ['app.example.com'],
      capabilities: [],
    });
  });

  it('returns a copy so mutating the result does not corrupt the holder', () => {
    setBridgeConfig({
      defaultPrivacyLevel: 'allow',
      allowedWebViewHosts: ['app.example.com'],
      capabilities: ['profiles'],
    });
    const config = getBridgeConfig();
    config.allowedWebViewHosts.push('evil.example.com');
    config.capabilities.push('evil');
    config.defaultPrivacyLevel = 'mask';
    expect(getBridgeConfig()).toEqual({
      defaultPrivacyLevel: 'allow',
      allowedWebViewHosts: ['app.example.com'],
      capabilities: ['profiles'],
    });
  });

  it('shares state across separate module evaluations via the process global', async () => {
    setBridgeConfig({ defaultPrivacyLevel: 'allow', allowedWebViewHosts: ['a.com'], capabilities: [] });
    // A fresh module evaluation must observe the value through the process-global holder,
    // not its own module-level state.
    vi.resetModules();
    const fresh = await import('./bridgeConfig');
    expect(fresh.getBridgeConfig().allowedWebViewHosts).toEqual(['a.com']);
  });
});
