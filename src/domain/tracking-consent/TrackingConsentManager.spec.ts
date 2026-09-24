import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { EventKind, EventManager, type RawEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import { startTelemetry, stopTelemetry } from '../telemetry';
import { TrackingConsentManager, type TrackingConsent, type TrackingConsentChange } from './index';

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
