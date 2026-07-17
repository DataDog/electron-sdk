import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerBridgeConfigResponder } from './registerBridgeConfig';
import { setBridgeConfig, CONFIG_CHANNEL } from '../common';

describe('registerBridgeConfigResponder', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:bridgeConfig')];
  });

  function makeIpcMain() {
    const listeners: Record<string, (event: { returnValue: unknown }) => void> = {};
    return {
      listeners,
      on: vi.fn((channel: string, listener: (event: { returnValue: unknown }) => void) => {
        listeners[channel] = listener;
      }),
    };
  }

  it('registers a listener on CONFIG_CHANNEL', () => {
    const ipcMain = makeIpcMain();
    registerBridgeConfigResponder(ipcMain as unknown as Electron.IpcMain);
    expect(ipcMain.on).toHaveBeenCalledWith(CONFIG_CHANNEL, expect.any(Function));
  });

  it('returns the fallback config before init', () => {
    const ipcMain = makeIpcMain();
    registerBridgeConfigResponder(ipcMain as unknown as Electron.IpcMain);
    const event = { returnValue: undefined as unknown };
    ipcMain.listeners[CONFIG_CHANNEL](event);
    expect(event.returnValue).toEqual({
      defaultPrivacyLevel: 'mask',
      allowedWebViewHosts: [],
      capabilities: ['profiles'],
    });
  });

  it('returns the real config after init updates the holder', () => {
    const ipcMain = makeIpcMain();
    registerBridgeConfigResponder(ipcMain as unknown as Electron.IpcMain);
    setBridgeConfig({ defaultPrivacyLevel: 'allow', allowedWebViewHosts: ['x.com'], capabilities: [] });
    const event = { returnValue: undefined as unknown };
    ipcMain.listeners[CONFIG_CHANNEL](event);
    expect(event.returnValue).toEqual({
      defaultPrivacyLevel: 'allow',
      allowedWebViewHosts: ['x.com'],
      capabilities: [],
    });
  });
});
