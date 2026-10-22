import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EvaluationAggregator,
  startEvaluationAggregator,
  EVALUATION_AGGREGATION_INTERVAL,
  MAIN_PROCESS_VIEW_URL,
} from './EvaluationAggregator';
import { FlagsState } from './FlagsState';
import { EventKind, EventManager, EventTrack, type ServerEvent } from '../../event';
import type { EvaluationRecord } from '../../common/flags/types';

const record: EvaluationRecord = {
  flagKey: 'targeted-flag',
  variant: 'variant-a',
  allocationKey: 'targeted-pro',
  reason: 'TARGETING_MATCH',
  doLog: true,
  serialId: 7,
  configurationId: 'config-1',
  contextRevision: 0,
  timestamp: 100 as never,
};

type Event = Record<string, unknown>;

describe('EvaluationAggregator', () => {
  let state: FlagsState;
  let events: Event[];
  let aggregator: EvaluationAggregator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    state = new FlagsState({ targetingKey: 'user-1', plan: 'pro' });
    events = [];
    aggregator = new EvaluationAggregator(state, { applicationId: 'app-id', service: 'svc' }, (emitted) =>
      events.push(...(emitted as unknown as Event[]))
    );
  });

  afterEach(() => {
    aggregator.stop();
    vi.useRealTimers();
  });

  it('emits the upstream FlagEvaluationEvent contract with allocation.key, the originating timestamps and context.dd enrichment', () => {
    aggregator.add(record);
    aggregator.add({ ...record, timestamp: 300 as never });
    aggregator.flush();
    expect(events).toEqual([
      {
        flag: { key: 'targeted-flag' },
        variant: { key: 'variant-a' },
        allocation: { key: 'targeted-pro' },
        targeting_key: 'user-1',
        first_evaluation: 100,
        last_evaluation: 300,
        evaluation_count: 2,
        runtime_default_used: false,
        timestamp: 5000,
        context: {
          evaluation: { plan: 'pro' },
          dd: { service: 'svc', rum: { application: { id: 'app-id' }, view: { url: MAIN_PROCESS_VIEW_URL } } },
        },
      },
    ]);
  });

  it('does not send serialId, configurationId or doLog, which the upstream contract has no fields for', () => {
    aggregator.add(record);
    aggregator.flush();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('serial');
    expect(serialized).not.toContain('config-1');
    expect(serialized).not.toMatch(/do_?log/i);
  });

  it('attributes main and renderer records to their own view url', () => {
    aggregator.add(record);
    aggregator.add({ ...record, viewUrl: 'app://window/index.html' });
    aggregator.flush();
    const urls = events.map((event) => (event.context as { dd: { rum: { view: { url: string } } } }).dd.rum.view.url);
    expect(urls.sort()).toEqual(['app://window/index.html', MAIN_PROCESS_VIEW_URL]);
  });

  it('counts default and error evaluations with runtime_default_used and a standard error code', () => {
    aggregator.add({
      ...record,
      variant: undefined,
      allocationKey: undefined,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    });
    aggregator.add({ ...record, flagKey: 'other', variant: undefined, reason: 'ERROR', errorCode: 'CUSTOM_CODE' });
    aggregator.flush();
    expect(events).toEqual([
      expect.objectContaining({
        flag: { key: 'targeted-flag' },
        runtime_default_used: true,
        error: { message: 'FLAG_NOT_FOUND' },
      }),
      expect.objectContaining({ flag: { key: 'other' }, runtime_default_used: true, error: { message: 'GENERAL' } }),
    ]);
  });

  it('drops records whose context revision is no longer retained', () => {
    aggregator.add({ ...record, contextRevision: 42 });
    aggregator.flush();
    expect(events).toEqual([]);
  });

  it('owns exactly one timer, flushes every 10000 ms and on stop', () => {
    const timersBefore = vi.getTimerCount();
    aggregator.start();
    expect(vi.getTimerCount()).toBe(timersBefore + 1);
    aggregator.add(record);
    vi.advanceTimersByTime(EVALUATION_AGGREGATION_INTERVAL - 1);
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(events).toHaveLength(1);
    aggregator.add(record);
    aggregator.stop();
    expect(events).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });
});

describe('startEvaluationAggregator', () => {
  it('sends aggregated events on the flagevaluation track when enabled, and is undefined when disabled', () => {
    vi.useFakeTimers();
    const state = new FlagsState({ targetingKey: 'user-1' });
    const eventManager = new EventManager();
    const serverEvents: ServerEvent[] = [];
    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => serverEvents.push(event),
    });
    expect(
      startEvaluationAggregator(state, { applicationId: 'app', enableFlagEvaluationTracking: false }, eventManager)
    ).toBeUndefined();
    const aggregator = startEvaluationAggregator(
      state,
      { applicationId: 'app', enableFlagEvaluationTracking: true },
      eventManager
    )!;
    aggregator.add(record);
    vi.advanceTimersByTime(EVALUATION_AGGREGATION_INTERVAL);
    expect(serverEvents).toEqual([expect.objectContaining({ track: EventTrack.FLAGEVALUATION })]);
    aggregator.stop();
    vi.useRealTimers();
  });
});
