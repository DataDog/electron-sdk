import { CONFIG_CHANNEL, getBridgeConfig } from '../common';
import { monitor } from '../domain/telemetry';

/**
 * Registers the bridge-config IPC responder at instrument time so the preload's synchronous config
 * request always finds a listener and returns immediately, even when init() is deferred or never
 * called. Before init() the responder returns the fallback config from the holder; init() replaces
 * it via setBridgeConfig.
 */
export function registerBridgeConfigResponder(ipcMain: Electron.IpcMain): void {
  ipcMain.on(
    CONFIG_CHANNEL,
    monitor((event: { returnValue: unknown }) => {
      event.returnValue = getBridgeConfig();
    })
  );
}
