import { monitor } from '../domain/telemetry';
import { addPendingSubscriber, getFlagsHolder, minimalFlagsSnapshot } from '../common/flags/flagsHolder';
import { FLAGS_BRIDGE_ENABLED_CHANNEL, FLAGS_SNAPSHOT_CHANNEL } from '../common';

/**
 * Thin instrument-time flags handlers (D13): answer NOT_READY and record the frame before
 * init, then delegate to init's handler; answer the preload's bridge question (P1).
 * `ipcMain` is passed in so this module never imports `electron` (B1).
 */
export function registerFlagsChannels(ipcMain: Electron.IpcMain): void {
  const holder = getFlagsHolder();
  if (holder.channelsRegistered === true) {
    return;
  }
  holder.channelsRegistered = true;

  ipcMain.handle(
    FLAGS_SNAPSHOT_CHANNEL,
    monitor((ipcEvent: Electron.IpcMainInvokeEvent) => {
      if (holder.isSenderExcluded?.(ipcEvent.sender) === true) {
        return undefined;
      }
      const handler = holder.flagsStateHandler;
      if (handler !== undefined) {
        return handler(ipcEvent);
      }
      const frame = ipcEvent.senderFrame;
      if (frame !== null && frame !== undefined) {
        addPendingSubscriber(frame);
      }
      return JSON.stringify(minimalFlagsSnapshot('NOT_READY'));
    })
  );

  ipcMain.on(
    FLAGS_BRIDGE_ENABLED_CHANNEL,
    monitor((event: Electron.IpcMainEvent) => {
      event.returnValue = holder.isSenderExcluded?.(event.sender) !== true;
    })
  );
}
