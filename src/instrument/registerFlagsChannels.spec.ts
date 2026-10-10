/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerFlagsChannels } from './registerFlagsChannels';
import { getFlagsHolder, takePendingSubscribers } from '../common/flags/flagsHolder';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore internal browser-core export, as in Telemetry.ts
import { startMonitorErrorCollection } from '@datadog/browser-core/cjs/tools/monitor';

function makeEvent(origin = 'https://app.example.com', processId = 1, routingId = 1): IpcMainInvokeEvent {
  return { senderFrame: { origin, url: origin, processId, routingId } } as unknown as IpcMainInvokeEvent;
}

function fakeIpcMain() {
  const handle = vi.fn();
  const on = vi.fn();
  return { ipcMain: { handle, on } as unknown as Electron.IpcMain, handle, on };
}

describe('registerFlagsChannels', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsHolder')];
  });

  it('answers the minimal NOT_READY snapshot (revision 0, no context, no configuration) before init and records the frame as pending', () => {
    const { ipcMain, handle } = fakeIpcMain();
    registerFlagsChannels(ipcMain);

    expect(handle).toHaveBeenCalledWith('datadog:flags-snapshot', expect.any(Function));
    const handler = handle.mock.calls[0][1];
    expect(JSON.parse(handler(makeEvent()) as string)).toEqual({
      revision: 0,
      status: 'NOT_READY',
      contextRevision: 0,
      configurationRevision: 0,
      tracking: { exposures: false, rum: false, evaluations: false },
    });
    expect(takePendingSubscribers()).toEqual([{ processId: 1, routingId: 1 }]);
  });

  it('delegates to the handler installed by init without recording a pending subscriber', () => {
    const { ipcMain, handle } = fakeIpcMain();
    registerFlagsChannels(ipcMain);
    getFlagsHolder().flagsStateHandler = () => JSON.stringify({ status: 'DISABLED' });

    expect(JSON.parse(handle.mock.calls[0][1](makeEvent()) as string)).toEqual({ status: 'DISABLED' });
    expect(takePendingSubscribers()).toEqual([]);
  });

  it('registers channels once even when called with two ipcMain instances', () => {
    const first = fakeIpcMain();
    const second = fakeIpcMain();
    registerFlagsChannels(first.ipcMain);
    registerFlagsChannels(second.ipcMain);
    expect(first.handle).toHaveBeenCalledTimes(1);
    expect(second.handle).not.toHaveBeenCalled();
  });

  it('handlers are monitored: a throwing init handler reaches telemetry, not the IPC caller', () => {
    const monitorErrors: unknown[] = [];
    startMonitorErrorCollection((error: unknown) => monitorErrors.push(error));
    try {
      const { ipcMain, handle } = fakeIpcMain();
      registerFlagsChannels(ipcMain);
      getFlagsHolder().flagsStateHandler = () => {
        throw new Error('handler failure');
      };
      expect(() => {
        handle.mock.calls[0][1](makeEvent());
      }).not.toThrow();
      expect(monitorErrors).toEqual([expect.objectContaining({ message: 'handler failure' })]);
    } finally {
      startMonitorErrorCollection(() => undefined);
    }
  });
  it('answers the preload bridge question: enabled before init and for included sessions, disabled for excluded ones', () => {
    const { ipcMain, on, handle } = fakeIpcMain();
    registerFlagsChannels(ipcMain);
    const bridgeEnabled = on.mock.calls.find((call) => call[0] === 'datadog:flags-bridge-enabled')![1] as (event: {
      sender: unknown;
      returnValue?: unknown;
    }) => void;
    const excludedSender = { id: 1 };
    const ask = (sender: unknown) => {
      const event: { sender: unknown; returnValue?: unknown } = { sender };
      bridgeEnabled(event);
      return event.returnValue;
    };
    expect(ask(excludedSender)).toBe(true);
    getFlagsHolder().isSenderExcluded = (sender) => sender === (excludedSender as unknown);
    expect(ask(excludedSender)).toBe(false);
    expect(ask({ id: 2 })).toBe(true);

    getFlagsHolder().flagsStateHandler = () => JSON.stringify({ status: 'READY' });
    expect(handle.mock.calls[0][1]({ ...makeEvent(), sender: excludedSender })).toBeUndefined();
  });
});
