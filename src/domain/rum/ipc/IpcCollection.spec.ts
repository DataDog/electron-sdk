import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Duration, TimeStamp } from '@datadog/js-core/time';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { IPC_HANDLE_CHANNEL, type IpcHandlerCall } from '../../../common';
import type { RawRumEvent } from '../../../event';
import { EventFormat, EventKind, EventManager } from '../../../event';
import type { RawRumMessageResource } from '../types';
import { IpcCollection } from './IpcCollection';

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

describe('IpcCollection', () => {
  let collection: IpcCollection;
  let rawRumEvents: RawRumEvent[];

  beforeEach(() => {
    const eventManager = new EventManager();
    rawRumEvents = [];
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });
    collection = new IpcCollection(eventManager);
  });

  afterEach(() => {
    collection.stop();
  });

  function publish(overrides: Partial<IpcHandlerCall> = {}) {
    DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL).publish({
      channel: 'settings:get',
      startTime: 1_000 as TimeStamp,
      duration: 12.5 as Duration,
      isError: false,
      ...overrides,
    });
  }

  it.each([false, true])('reports a handler call as a message resource dated at its start, is_error: %s', (isError) => {
    publish({ isError });

    expect(rawRumEvents).toHaveLength(1);
    expect(rawRumEvents[0].startTime).toBe(1_000);
    const data = rawRumEvents[0].data as RawRumMessageResource;
    expect(data.resource.id).toMatch(UUID_REGEX);
    expect(data.resource.message.id).toMatch(UUID_REGEX);
    expect(data).toEqual({
      type: 'resource',
      date: 1_000,
      resource: {
        id: data.resource.id,
        duration: 12_500_000,
        type: 'message',
        url: 'settings:get',
        message: { id: data.resource.message.id, role: 'destination', api: 'handle', is_error: isError },
      },
    });
  });

  it('gives each call a resource id and a message id of its own', () => {
    publish();
    publish();

    const [first, second] = rawRumEvents.map((event) => (event.data as RawRumMessageResource).resource);
    expect(first.id).not.toBe(second.id);
    expect(first.message.id).not.toBe(second.message.id);
  });

  it('keeps a failure to report a call away from the process', async () => {
    // diagnostics_channel raises a subscriber's error again as an uncaughtException on the next tick.
    const onUncaughtException = vi.fn();
    process.on('uncaughtException', onUncaughtException);

    DiagnosticsChannel.channel(IPC_HANDLE_CHANNEL).publish(undefined);
    await new Promise((resolve) => setImmediate(resolve));
    process.off('uncaughtException', onUncaughtException);

    expect(onUncaughtException).not.toHaveBeenCalled();
  });

  it('stops reporting once stopped', () => {
    collection.stop();

    publish();

    expect(rawRumEvents).toEqual([]);
  });
});
