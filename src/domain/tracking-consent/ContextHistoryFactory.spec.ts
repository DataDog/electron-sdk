import fs from 'node:fs/promises';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextHistoryFactory, TrackingConsentManager, type TrackingConsent } from './index';

vi.mock('node:fs/promises');

describe('ContextHistoryFactory', () => {
  let consent: TrackingConsentManager;
  let factory: ContextHistoryFactory;
  let disk: Map<string, string>;
  const expireDelay = 60_000;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    consent = new TrackingConsentManager();
    factory = new ContextHistoryFactory(consent, '/data');
    disk = new Map();
    vi.mocked(fs.readFile).mockImplementation((file) => Promise.resolve(disk.get(file as string) ?? '[]'));
    vi.mocked(fs.writeFile).mockImplementation((file, data) => {
      disk.set(file as string, data as string);
      return Promise.resolve();
    });
  });

  afterEach(() => {
    factory.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function persisted(file = 'history') {
    await vi.advanceTimersByTimeAsync(0);
    return JSON.parse(disk.get(`/data/${file}`) ?? '[]') as {
      value: unknown;
      startTime: number;
      endTime: number | null;
    }[];
  }

  it('keeps pending values in memory until a grant', async () => {
    const history = await factory.create<string>('history', expireDelay);
    history.set('Alice', timeStampNow());
    vi.setSystemTime(2000);
    consent.update('pending');
    vi.setSystemTime(2500);
    history.set('Bob', timeStampNow());

    expect(history.find(2200 as TimeStamp)).toBe('Alice');
    expect(history.find(2500 as TimeStamp)).toBe('Bob');
    expect(await persisted()).toEqual([{ value: 'Alice', startTime: 1000, endTime: 2000 }]);

    consent.update('granted');
    expect(await persisted()).toEqual([
      { value: 'Bob', startTime: 2500, endTime: null },
      { value: 'Alice', startTime: 2000, endTime: 2500 },
      { value: 'Alice', startTime: 1000, endTime: 2000 },
    ]);
  });

  it('drops refused history while keeping the latest value for a later grant', async () => {
    const history = await factory.create<string>('history', expireDelay);
    history.set('Alice', timeStampNow());
    vi.setSystemTime(2000);
    consent.update('pending');
    history.set('Bob', timeStampNow());
    vi.setSystemTime(3000);
    consent.update('not-granted');
    history.set('Carol', timeStampNow());

    expect(history.find(1500 as TimeStamp)).toBe('Alice');
    expect(history.find(2500 as TimeStamp)).toBeUndefined();
    expect(history.find(3000 as TimeStamp)).toBeUndefined();
    expect(await persisted()).toEqual([{ value: 'Alice', startTime: 1000, endTime: 2000 }]);

    vi.setSystemTime(4000);
    consent.update('granted');
    expect(history.find(3999 as TimeStamp)).toBeUndefined();
    expect(history.find(4000 as TimeStamp)).toBe('Carol');
  });

  it('starts a new pending period after refusal without reviving rejected changes', async () => {
    consent.update('pending');
    const history = await factory.create<string>('history', expireDelay);
    history.set('old', timeStampNow());
    vi.setSystemTime(2000);
    consent.update('not-granted');
    history.set('current', timeStampNow());
    vi.setSystemTime(3000);
    consent.update('pending');

    expect(history.find(1500 as TimeStamp)).toBeUndefined();
    expect(history.find(2500 as TimeStamp)).toBeUndefined();
    expect(history.find(3000 as TimeStamp)).toBe('current');
    expect(await persisted()).toEqual([]);

    consent.update('granted');
    expect(await persisted()).toEqual([{ value: 'current', startTime: 3000, endTime: null }]);
  });

  it.each<TrackingConsent>(['pending', 'not-granted'])('respects a value cleared while %s', async (state) => {
    const history = await factory.create<string>('history', expireDelay);
    history.set('Alice', timeStampNow());
    vi.setSystemTime(2000);
    consent.update(state);
    history.set(undefined, timeStampNow());
    vi.setSystemTime(3000);
    consent.update('granted');

    expect(history.find(3000 as TimeStamp)).toBeUndefined();
    expect((await persisted()).every((entry) => entry.endTime !== null)).toBe(true);
  });

  it('does not restore rejected changes when refusal and grant share a timestamp', async () => {
    const history = await factory.create<string>('history', expireDelay);
    consent.update('pending');
    history.set('Bob', timeStampNow());
    vi.setSystemTime(2000);
    consent.update('not-granted');
    consent.update('granted');

    expect(history.find(1999 as TimeStamp)).toBeUndefined();
    expect(history.find(2000 as TimeStamp)).toBe('Bob');
    expect(await persisted()).toEqual([{ value: 'Bob', startTime: 2000, endTime: null }]);
  });

  it.each<TrackingConsent>(['pending', 'not-granted'])(
    'uses saved history for the previous process without restoring its current value in %s',
    async (state) => {
      disk.set('/data/history', JSON.stringify([{ value: 'previous', startTime: 100, endTime: null }]));
      consent.update(state);
      const history = await factory.create<string>('history', expireDelay);
      expect(history.find(999 as TimeStamp)).toBe('previous');
      expect(history.find(1000 as TimeStamp)).toBeUndefined();
      expect(await persisted()).toEqual([{ value: 'previous', startTime: 100, endTime: 1000 }]);

      vi.setSystemTime(2000);
      consent.update('granted');
      expect(history.find(2000 as TimeStamp)).toBeUndefined();
    }
  );

  it('starts empty when the saved value is not an entry list, and prunes expired history', async () => {
    disk.set('/data/invalid', '{}');
    const empty = await factory.create('invalid', expireDelay);
    expect(empty.find(timeStampNow())).toBeUndefined();
    disk.set('/data/history', JSON.stringify([{ value: 'expired', startTime: 100, endTime: 200 }]));
    const history = await factory.create<string>('history', 100);
    expect(history.find(150 as TimeStamp)).toBeUndefined();
    history.set('current', timeStampNow());
    vi.setSystemTime(1200);
    history.set(undefined, timeStampNow());
    vi.setSystemTime(1400);
    history.set(undefined, timeStampNow());
    expect(await persisted()).toEqual([]);
  });

  it('updates every history before a collector can record a value during the transition', async () => {
    const first = await factory.create<string>('first', expireDelay);
    const subscription = consent.subscribe((change) => {
      expect(first.find(change.time)).toBe('first');
      second.set('next', change.time);
    });
    // Even histories created after a collector subscription belong to the factory's first callback.
    const second = await factory.create<string>('second', expireDelay);
    first.set('first', timeStampNow());
    second.set('second', timeStampNow());
    vi.setSystemTime(2000);
    consent.update('pending');

    expect(second.find(2000 as TimeStamp)).toBe('next');
    expect(await persisted('second')).toEqual([{ value: 'second', startTime: 1000, endTime: 2000 }]);
    subscription.unsubscribe();
  });

  it('isolates serialization errors so another history still applies the transition', async () => {
    const broken = await factory.create<unknown>('broken', expireDelay);
    const healthy = await factory.create<string>('healthy', expireDelay);
    consent.update('pending');
    broken.set(1n, timeStampNow());
    healthy.set('accepted', timeStampNow());
    const observed = vi.fn();
    const subscription = consent.subscribe(observed);

    expect(() => consent.update('granted')).not.toThrow();
    expect(observed).toHaveBeenCalledOnce();
    expect(await persisted('healthy')).toEqual([{ value: 'accepted', startTime: 1000, endTime: null }]);
    vi.setSystemTime(2000);
    expect(() => consent.update('pending')).not.toThrow();
    broken.set('pending', timeStampNow());
    expect(await persisted('broken')).toEqual([]);
    subscription.unsubscribe();
  });

  it('uses the latest consent when a history finishes loading', async () => {
    let finishRead!: (value: string) => void;
    vi.mocked(fs.readFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        })
    );
    const loading = factory.create<string>('history', expireDelay);
    consent.update('not-granted');
    finishRead('[]');
    const history = await loading;
    history.set('denied', timeStampNow());
    expect(history.find(timeStampNow())).toBeUndefined();
    expect(await persisted()).toEqual([]);
  });

  it('releases the shared consent subscription when stopped', async () => {
    await factory.create('history', expireDelay);
    await persisted();
    factory.stop();
    vi.mocked(fs.writeFile).mockClear();
    consent.update('pending');
    await persisted();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
