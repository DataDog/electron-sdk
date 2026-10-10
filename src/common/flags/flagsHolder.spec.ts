import { describe, it, expect, beforeEach } from 'vitest';
import { addPendingSubscriber, getFlagsHolder, MAX_PENDING_SUBSCRIBERS, takePendingSubscribers } from './flagsHolder';

describe('flagsHolder', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsHolder')];
  });

  it('instrument and init module instances observe the same holder', () => {
    const first = getFlagsHolder();
    const second = getFlagsHolder();
    expect(first).toBe(second);
  });

  it('reports channels registered once across module instances', () => {
    const holder = getFlagsHolder();
    expect(holder.channelsRegistered).toBeUndefined();
    holder.channelsRegistered = true;
    expect(getFlagsHolder().channelsRegistered).toBe(true);
  });

  it('carries the state handler installed by init', () => {
    const handler = () => 'snapshot';
    getFlagsHolder().flagsStateHandler = handler;
    expect(getFlagsHolder().flagsStateHandler).toBe(handler);
  });
  it('bounds pending subscribers to 1000 and drops the oldest', () => {
    for (let routingId = 0; routingId < MAX_PENDING_SUBSCRIBERS + 2; routingId += 1) {
      addPendingSubscriber({ processId: 1, routingId });
    }
    addPendingSubscriber({ processId: 1, routingId: MAX_PENDING_SUBSCRIBERS + 1 });
    const pending = takePendingSubscribers();
    expect(pending).toHaveLength(MAX_PENDING_SUBSCRIBERS);
    expect(pending[0]).toEqual({ processId: 1, routingId: 2 });
    expect(pending[pending.length - 1]).toEqual({ processId: 1, routingId: MAX_PENDING_SUBSCRIBERS + 1 });
    expect(takePendingSubscribers()).toEqual([]);
  });
});
