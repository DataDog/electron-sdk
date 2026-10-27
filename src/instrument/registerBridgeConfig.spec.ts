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

  it('returns no config before init', () => {
    const ipcMain = makeIpcMain();
    registerBridgeConfigResponder(ipcMain as unknown as Electron.IpcMain);
    const event = { returnValue: undefined as unknown };
    ipcMain.listeners[CONFIG_CHANNEL](event);
    expect(event.returnValue).toBeNull();
  });

  it('returns the config once init publishes it', () => {
    const ipcMain = makeIpcMain();
    registerBridgeConfigResponder(ipcMain as unknown as Electron.IpcMain);
    setBridgeConfig({ defaultPrivacyLevel: 'allow', allowedRendererHosts: ['x.com'], capabilities: [] });
    const event = { returnValue: undefined as unknown };
    ipcMain.listeners[CONFIG_CHANNEL](event);
    expect(event.returnValue).toEqual({
      defaultPrivacyLevel: 'allow',
      allowedRendererHosts: ['x.com'],
      capabilities: [],
    });
  });
});
