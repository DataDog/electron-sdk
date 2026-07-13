import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawRumEvent } from '../../../event';
import { EventFormat, EventKind, EventManager, LifecycleKind } from '../../../event';
import { display } from '../../../tools/display';
import type { RawRumDurationVital } from '../rawRumData.types';
import { DurationVitalCollection } from './DurationVitalCollection';

vi.mock('../../../tools/display', () => ({
  display: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

describe('DurationVitalCollection', () => {
  let eventManager: EventManager;
  let collection: DurationVitalCollection;
  let api: ReturnType<DurationVitalCollection['getApi']>;
  let rawRumEvents: RawRumEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    eventManager = new EventManager();
    rawRumEvents = [];
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });
    collection = new DurationVitalCollection(eventManager);
    api = collection.getApi();
  });

  afterEach(() => {
    collection.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('adds a completed vital with its start time, duration, and optional data', () => {
    api.addDurationVital('database.migration', {
      startTime: 500,
      duration: 1_234.5,
      vitalKey: 'not-serialized',
      context: { migration: 'users' },
      description: 'initial migration',
    });

    expect(rawRumEvents).toHaveLength(1);
    expect(rawRumEvents[0].startTime).toBe(500);
    const data = rawRumEvents[0].data as RawRumDurationVital;
    expect(data.vital.id).toMatch(UUID_REGEX);
    expect(data).toEqual({
      type: 'vital',
      date: 500,
      context: { migration: 'users' },
      vital: {
        id: data.vital.id,
        name: 'database.migration',
        type: 'duration',
        duration: 1_234_500_000,
        description: 'initial migration',
      },
    });
    expect(data.vital).not.toHaveProperty('vital_key');
  });

  it('emits only when a started vital is stopped and preserves the start timestamp', () => {
    api.startDurationVital('document.open');
    expect(rawRumEvents).toHaveLength(0);

    vi.advanceTimersByTime(250);
    api.stopDurationVital('document.open');

    expect(rawRumEvents).toHaveLength(1);
    expect(rawRumEvents[0].startTime).toBe(1_000);
    const data = rawRumEvents[0].data as RawRumDurationVital;
    expect(data.date).toBe(1_000);
    expect(data.vital.duration).toBe(250_000_000);
  });

  it('tracks concurrent vitals with the same name by vitalKey', () => {
    api.startDurationVital('file.load', { vitalKey: 'a' });
    vi.advanceTimersByTime(100);
    api.startDurationVital('file.load', { vitalKey: 'b' });
    vi.advanceTimersByTime(100);

    api.stopDurationVital('file.load', { vitalKey: 'a' });
    api.stopDurationVital('file.load', { vitalKey: 'b' });

    expect(rawRumEvents.map((event) => (event.data as RawRumDurationVital).vital.duration)).toEqual([
      200_000_000, 100_000_000,
    ]);
  });

  it('replaces an existing pending vital when its key is started again', () => {
    api.startDurationVital('sync');
    vi.advanceTimersByTime(100);
    api.startDurationVital('sync');
    vi.advanceTimersByTime(50);
    api.stopDurationVital('sync');

    const data = rawRumEvents[0].data as RawRumDurationVital;
    expect(data.date).toBe(1_100);
    expect(data.vital.duration).toBe(50_000_000);
  });

  it('ignores unknown and repeated stops', () => {
    api.stopDurationVital('unknown');
    api.startDurationVital('known');
    api.stopDurationVital('known');
    api.stopDurationVital('known');

    expect(rawRumEvents).toHaveLength(1);
  });

  it('snapshots and deep-merges start and stop options', () => {
    const context = { nested: { started: true } };
    api.startDurationVital('checkout', { context, description: 'start' });
    context.nested.started = false;
    api.stopDurationVital('checkout', {
      context: { nested: { stopped: true } },
      description: 'stop',
    });

    const data = rawRumEvents[0].data as RawRumDurationVital;
    expect(data.context).toEqual({ nested: { started: true, stopped: true } });
    expect(data.vital.description).toBe('stop');
  });

  it('clears pending vitals when the session renews', () => {
    api.startDurationVital('checkout');
    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
    api.stopDurationVital('checkout');

    expect(rawRumEvents).toHaveLength(0);
  });

  it('clears pending vitals when stopped', () => {
    api.startDurationVital('checkout');
    collection.stop();
    api.stopDurationVital('checkout');

    expect(rawRumEvents).toHaveLength(0);
  });

  it.each([
    ['blank name', '', { startTime: 0, duration: 1 }],
    ['missing options', 'vital', undefined],
    ['non-finite startTime', 'vital', { startTime: Number.NaN, duration: 1 }],
    ['non-finite duration', 'vital', { startTime: 0, duration: Number.POSITIVE_INFINITY }],
  ])('rejects invalid addDurationVital input: %s', (_label, name, options) => {
    api.addDurationVital(name, options as never);

    expect(rawRumEvents).toHaveLength(0);
    expect(display.error).toHaveBeenCalledOnce();
  });

  it('warns but emits a name outside the documented backend character set', () => {
    api.addDurationVital('document open', { startTime: 0, duration: 1 });

    expect(rawRumEvents).toHaveLength(1);
    expect(display.warn).toHaveBeenCalledOnce();
  });
});
