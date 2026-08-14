import { describe, it, expect, vi } from 'vitest';
import { EventKind, EventFormat, EventManager } from '../../event';
import { IpcResourceCollector } from './IpcResourceCollector';
import type { IpcChannelMessage } from '../../instrument/ipc';

describe('IpcResourceCollector', () => {
  it('emits a RUM ipc resource event when the registered handler is invoked', () => {
    const eventManager = new EventManager();
    const notifySpy = vi.spyOn(eventManager, 'notify');

    let registeredHandler: ((message: IpcChannelMessage) => void) | undefined;
    const fakeSetIpcEventHandler = (handler: (message: IpcChannelMessage) => void) => {
      registeredHandler = handler;
    };

    new IpcResourceCollector(eventManager, fakeSetIpcEventHandler);

    registeredHandler!({
      role: 'destination',
      id: 'call-abc',
      method: 'handle',
      channel: 'get-profile',
      startTime: 1000,
      duration: 42,
      error: false,
    });

    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: EventKind.RAW,
        format: EventFormat.RUM,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          type: 'resource',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          resource: expect.objectContaining({ type: 'native', url: 'get-profile' }),
          context: { ipc: { role: 'destination', id: 'call-abc', method: 'handle' } },
        }),
      })
    );
  });
});
