import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { EventKind, EventManager, type RawEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import { startTelemetry, stopTelemetry } from '../telemetry';
import { TrackingConsentManager, type TrackingConsent, type TrackingConsentChange } from './index';

vi.mock('node:fs/promises');

describe('TrackingConsentManager', () => {
  let manager: TrackingConsentManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    manager = new TrackingConsentManager();
  });

  afterEach(() => {
    stopTelemetry();
    vi.useRealTimers();
  });

  it('starts granted without assigning consent to times before its creation', () => {
    expect(manager.get()).toBe('granted');
    expect(manager.getAt(999 as TimeStamp)).toBeUndefined();
    expect(manager.getAt(1000 as TimeStamp)).toBe('granted');
  });

  it.each<[TrackingConsent, TrackingConsent]>([
    ['granted', 'pending'],
    ['granted', 'not-granted'],
    ['pending', 'granted'],
    ['pending', 'not-granted'],
    ['not-granted', 'granted'],
    ['not-granted', 'pending'],
  ])('notifies the %s → %s transition after updating the current state', (previous, current) => {
    manager.update(previous);
    const observedStates: TrackingConsent[] = [];
    const observer = vi.fn(() => observedStates.push(manager.get()));
    manager.subscribe(observer);
    vi.advanceTimersByTime(10);

    manager.update(current);

    expect(observer).toHaveBeenCalledExactlyOnceWith({ previous, current, time: 1010 });
    expect(observedStates).toEqual([current]);
  });

  it.each<TrackingConsent>(['granted', 'pending', 'not-granted'])('does not notify when %s is set again', (consent) => {
    manager.update(consent);
    const observer = vi.fn();
    manager.subscribe(observer);
    vi.advanceTimersByTime(10);

    manager.update(consent);

    expect(observer).not.toHaveBeenCalled();
  });

  it.each<TrackingConsent>(['granted', 'not-granted'])(
    'keeps the original pending state in history after a %s decision',
    (decision) => {
      vi.advanceTimersByTime(10);
      manager.update('pending');
      vi.advanceTimersByTime(10);
      manager.update(decision);

      expect(manager.getAt(1009 as TimeStamp)).toBe('granted');
      expect(manager.getAt(1010 as TimeStamp)).toBe('pending');
      expect(manager.getAt(1019 as TimeStamp)).toBe('pending');
      expect(manager.getAt(1020 as TimeStamp)).toBe(decision);
    }
  );

  it('returns the last state when transitions share a timestamp', () => {
    const observer = vi.fn<(change: TrackingConsentChange) => void>();
    manager.subscribe(observer);
    vi.advanceTimersByTime(10);

    manager.update('pending');
    manager.update('not-granted');
    manager.update('granted');

    expect(manager.getAt(1009 as TimeStamp)).toBe('granted');
    expect(manager.getAt(1010 as TimeStamp)).toBe('granted');
    expect(observer.mock.calls.map(([change]) => change.current)).toEqual(['pending', 'not-granted', 'granted']);
  });

  it('reports observer errors without interrupting other observers', () => {
    const eventManager = new EventManager();
    const onTelemetry = vi.fn<(event: RawEvent) => void>();
    eventManager.registerHandler<RawEvent>({
      canHandle: (event) => event.kind === EventKind.RAW,
      handle: (event) => onTelemetry(event),
    });
    startTelemetry(eventManager, createTestConfiguration({ telemetrySampleRate: 100 }));
    manager.subscribe(() => {
      throw new Error('consent observer failed');
    });
    const states: TrackingConsent[] = [];
    manager.subscribe((change) => states.push(change.current));

    expect(() => manager.update('pending')).not.toThrow();

    expect(states).toEqual(['pending']);
    expect(onTelemetry.mock.calls).toMatchObject([
      [{ data: { telemetry: { status: 'error', message: 'consent observer failed' } } }],
    ]);
  });

  it('stops notifying an unsubscribed observer', () => {
    const observer = vi.fn();
    const subscription = manager.subscribe(observer);
    subscription.unsubscribe();

    manager.update('pending');

    expect(observer).not.toHaveBeenCalled();
    expect(manager.get()).toBe('pending');
  });

  it('keeps state, history and observers independent between instances', () => {
    vi.advanceTimersByTime(10);
    const other = new TrackingConsentManager();
    const otherObserver = vi.fn();
    other.subscribe(otherObserver);

    manager.update('pending');

    expect(other.get()).toBe('granted');
    expect(other.getAt(1000 as TimeStamp)).toBeUndefined();
    expect(other.getAt(1010 as TimeStamp)).toBe('granted');
    expect(otherObserver).not.toHaveBeenCalled();
  });
});

describe('persisted tracking consent', () => {
  let file: string;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    file = '[]';
    vi.mocked(fs.readFile).mockImplementation(() => Promise.resolve(file));
    vi.mocked(fs.writeFile).mockImplementation((_path, data) => {
      file = data as string;
      return Promise.resolve();
    });
  });

  afterEach(() => vi.useRealTimers());

  it('recovers granted consent without restoring it as the new launch state', async () => {
    const first = await TrackingConsentManager.start('/history');
    vi.setSystemTime(1020);
    const next = await TrackingConsentManager.start('/history', 'pending');

    expect(next.get()).toBe('pending');
    expect(next.getAt(1010 as TimeStamp)).toBeUndefined();
    expect(next.isAuthorizedAt(1010 as TimeStamp)).toBe(true);
    expect(next.getAt(999 as TimeStamp)).toBeUndefined();
    expect(next.isAuthorizedAt(999 as TimeStamp)).toBe(false);
    expect(next.isAuthorizedAt(1020 as TimeStamp)).toBe(false);
    expect(JSON.parse(file)).toEqual([{ startTime: 1020, endTime: null, value: 'pending' }]);
    await first.flush();
  });

  it('never authorizes the previous launch pending interval with a new launch grant', async () => {
    await TrackingConsentManager.start('/history', 'pending');
    vi.setSystemTime(1020);
    const next = await TrackingConsentManager.start('/history');

    expect(next.get()).toBe('granted');
    expect(next.getAt(1010 as TimeStamp)).toBeUndefined();
    expect(next.isAuthorizedAt(1010 as TimeStamp)).toBe(false);

    next.update('not-granted');
    next.update('granted');
    expect(next.isAuthorizedAt(1010 as TimeStamp)).toBe(false);
    await next.flush();
    vi.setSystemTime(1040);
    const later = await TrackingConsentManager.start('/history');
    expect(later.getAt(1010 as TimeStamp)).toBeUndefined();
  });

  it.each([false, true])(
    'uses the first decision after pending, even after restart (rejected: %s)',
    async (rejected) => {
      const first = await TrackingConsentManager.start('/history', 'pending');
      vi.setSystemTime(1020);
      if (rejected) first.update('not-granted');
      first.update('granted');
      await first.flush();

      expect(first.getAt(1010 as TimeStamp)).toBe('pending');
      expect(first.isAuthorizedAt(1010 as TimeStamp)).toBe(!rejected);

      vi.setSystemTime(1040);
      const next = await TrackingConsentManager.start('/history');
      expect(next.getAt(1010 as TimeStamp)).toBeUndefined();
      expect(next.isAuthorizedAt(1010 as TimeStamp)).toBe(!rejected);
      expect(next.isAuthorizedAt(1020 as TimeStamp)).toBe(true);
    }
  );

  it('queues persistence before notifying synchronous observers', async () => {
    const manager = await TrackingConsentManager.start('/history');
    const observer = vi.fn<(consent: TrackingConsent, change: TrackingConsentChange) => void>();
    manager.subscribe((change) => {
      observer(manager.get(), change);
      if (change.current === 'pending') manager.update('not-granted');
    });
    vi.setSystemTime(1020);
    manager.update('pending');
    await manager.flush();

    expect(observer.mock.calls.map(([consent]) => consent)).toEqual(['pending', 'not-granted']);
    const snapshots = vi
      .mocked(fs.writeFile)
      .mock.calls.map((call) => JSON.parse(call[1] as string) as { value: TrackingConsent }[]);
    expect(snapshots.map((entries) => entries[0].value)).toEqual(['granted', 'pending', 'not-granted']);
    expect(snapshots[snapshots.length - 1]).toEqual([
      { startTime: 1020, endTime: null, value: 'not-granted' },
      { startTime: 1020, endTime: 1020, value: 'pending' },
      { startTime: 1000, endTime: 1020, value: 'granted' },
    ]);
  });

  it('has no authorization for missing history or invalid timestamps', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const manager = await TrackingConsentManager.start('/history');
    for (const time of [999, NaN, Infinity, -Infinity]) {
      expect(manager.isAuthorizedAt(time as TimeStamp)).toBe(false);
    }
  });
});
