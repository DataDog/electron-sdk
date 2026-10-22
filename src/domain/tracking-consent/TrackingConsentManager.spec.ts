import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { DISCARDED } from '@datadog/js-core/assembly';
import { createFormatHooks } from '../../assembly';
import { EventKind, EventManager, EventSource, type RawEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import { startTelemetry, stopTelemetry } from '../telemetry';
import { TrackingConsentManager, type TrackingConsent, type TrackingConsentChange } from './index';

vi.mock('node:fs/promises');
vi.mock('electron', () => ({ app: { getPath: () => '/mock/user/data' } }));

describe('TrackingConsentManager', () => {
  let file: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    file = '[]';
    vi.mocked(fs.readFile).mockImplementation(() => Promise.resolve(file));
    vi.mocked(fs.writeFile).mockImplementation((_path, data) => {
      file = data as string;
      return Promise.resolve();
    });
  });

  afterEach(() => {
    stopTelemetry();
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  async function launch(initialConsent: TrackingConsent = 'granted') {
    // Let the previous launch finish writing its history.
    await vi.advanceTimersByTimeAsync(0);
    const hooks = createFormatHooks();
    const manager = await TrackingConsentManager.init(hooks, initialConsent);
    // Logs and spans get the same check as RUM events: every decision below is asserted for all three.
    const isDiscardedAt = (time: number) => {
      const startTime = time as TimeStamp;
      const discarded = hooks.triggerRum({ eventType: 'error', startTime, source: EventSource.MAIN }) === DISCARDED;
      expect(hooks.triggerLogs({ startTime, source: EventSource.RENDERER }) === DISCARDED).toBe(discarded);
      expect(hooks.triggerSpan({ startTime, source: EventSource.MAIN }) === DISCARDED).toBe(discarded);
      return discarded;
    };
    return { manager, isDiscardedAt };
  }

  it('discards events captured before its creation', async () => {
    const { isDiscardedAt } = await launch();

    expect(isDiscardedAt(999)).toBe(true);
    expect(isDiscardedAt(1000)).toBe(false);
  });

  it.each<[TrackingConsent, TrackingConsent]>([
    ['granted', 'pending'],
    ['granted', 'not-granted'],
    ['pending', 'granted'],
    ['pending', 'not-granted'],
    ['not-granted', 'granted'],
    ['not-granted', 'pending'],
  ])('notifies the %s → %s transition after updating the current state', async (previous, current) => {
    const { manager } = await launch(previous);
    const observedStates: TrackingConsent[] = [];
    const observer = vi.fn(() => observedStates.push(manager.get()));
    manager.subscribe(observer);
    vi.advanceTimersByTime(10);

    manager.update(current);

    expect(observer).toHaveBeenCalledExactlyOnceWith({ previous, current, time: 1010 });
    expect(observedStates).toEqual([current]);
  });

  it.each<TrackingConsent>(['granted', 'pending', 'not-granted'])(
    'does not notify when %s is set again',
    async (consent) => {
      const { manager } = await launch(consent);
      const observer = vi.fn();
      manager.subscribe(observer);
      vi.advanceTimersByTime(10);

      manager.update(consent);

      expect(observer).not.toHaveBeenCalled();
    }
  );

  it('returns the last state when transitions share a timestamp', async () => {
    const { manager, isDiscardedAt } = await launch();
    const observer = vi.fn<(change: TrackingConsentChange) => void>();
    manager.subscribe(observer);
    vi.advanceTimersByTime(10);

    manager.update('pending');
    manager.update('not-granted');
    manager.update('granted');

    expect(manager.get()).toBe('granted');
    expect(isDiscardedAt(1010)).toBe(false);
    expect(observer.mock.calls.map(([change]) => change.current)).toEqual(['pending', 'not-granted', 'granted']);
  });

  it('reports observer errors without interrupting other observers', async () => {
    const { manager } = await launch();
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

  it('stops notifying an unsubscribed observer', async () => {
    const { manager } = await launch();
    const observer = vi.fn();
    const subscription = manager.subscribe(observer);
    subscription.unsubscribe();

    manager.update('pending');

    expect(observer).not.toHaveBeenCalled();
    expect(manager.get()).toBe('pending');
  });

  it('keeps state and observers independent between instances', async () => {
    const { manager } = await launch();
    const { manager: other } = await launch();
    const otherObserver = vi.fn();
    other.subscribe(otherObserver);

    manager.update('pending');

    expect(other.get()).toBe('granted');
    expect(otherObserver).not.toHaveBeenCalled();
  });

  describe('across launches', () => {
    it('checks events against the consent of their own launch without restoring it as the current state', async () => {
      await launch();
      vi.setSystemTime(1020);
      const { manager, isDiscardedAt } = await launch('pending');

      expect(manager.get()).toBe('pending');
      expect(isDiscardedAt(1010)).toBe(false);
      expect(isDiscardedAt(1020)).toBe(false);
      expect(isDiscardedAt(999)).toBe(true);
    });

    it('refuses a pending period left undecided by the previous launch', async () => {
      await launch('pending');
      vi.setSystemTime(1020);
      const { manager, isDiscardedAt } = await launch();

      expect(isDiscardedAt(1010)).toBe(true);
      manager.update('not-granted');
      manager.update('granted');
      expect(isDiscardedAt(1010)).toBe(true);

      vi.setSystemTime(1040);
      expect((await launch()).isDiscardedAt(1010)).toBe(true);
    });

    it.each<TrackingConsent>(['granted', 'not-granted'])(
      'applies the first %s decision to a pending period, including after a restart',
      async (decision) => {
        const { manager, isDiscardedAt } = await launch('pending');
        expect(isDiscardedAt(1000)).toBe(false);

        vi.setSystemTime(1020);
        manager.update(decision);
        vi.setSystemTime(1030);
        manager.update(decision === 'granted' ? 'not-granted' : 'granted');
        expect(isDiscardedAt(1010)).toBe(decision === 'not-granted');

        vi.setSystemTime(1040);
        expect((await launch()).isDiscardedAt(1010)).toBe(decision === 'not-granted');
      }
    );
  });
});
