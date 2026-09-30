import fs from 'node:fs/promises';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackingConsentHistory, TrackingConsentManager, type TrackingConsent } from './index';

vi.mock('node:fs/promises');

describe('TrackingConsentHistory', () => {
  const filePath = '/data/history';
  const options = { filePath, expireDelay: 60_000 };
  let manager: TrackingConsentManager;
  let history: TrackingConsentHistory<string>;
  let disk: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    manager = new TrackingConsentManager();
    disk = '[]';
    vi.mocked(fs.readFile).mockImplementation(() => Promise.resolve(disk));
    vi.mocked(fs.writeFile).mockImplementation((_file, data) => {
      disk = data as string;
      return Promise.resolve();
    });
  });

  afterEach(() => {
    history.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const persisted = async () => {
    await vi.advanceTimersByTimeAsync(0);
    return JSON.parse(disk) as { value: string; startTime: number; endTime: number | null }[];
  };

  it('preserves the authorized interval and commits pending changes only after a grant', async () => {
    history = await TrackingConsentHistory.init<string>(options, manager);
    history.add('authorized', timeStampNow());
    vi.setSystemTime(2000);
    manager.update('pending');
    vi.setSystemTime(2500);
    history.closeAndAdd('pending', timeStampNow());

    expect(history.find(2200 as TimeStamp)).toBe('authorized');
    expect(history.find(2500 as TimeStamp)).toBe('pending');
    expect(await persisted()).toEqual([{ value: 'authorized', startTime: 1000, endTime: 2000 }]);

    vi.setSystemTime(3000);
    manager.update('granted');

    expect(await persisted()).toEqual([
      { value: 'pending', startTime: 2500, endTime: null },
      { value: 'authorized', startTime: 2000, endTime: 2500 },
      { value: 'authorized', startTime: 1000, endTime: 2000 },
    ]);
  });

  it('forgets rejected history and resumes with the latest value without backdating it', async () => {
    history = await TrackingConsentHistory.init<string>(options, manager);
    history.add('authorized', timeStampNow());
    vi.setSystemTime(2000);
    manager.update('pending');
    history.closeAndAdd('rejected', timeStampNow());
    vi.setSystemTime(3000);
    manager.update('not-granted');
    history.closeAndAdd('current', timeStampNow());

    expect(history.find(1500 as TimeStamp)).toBe('authorized');
    expect(history.find(2500 as TimeStamp)).toBeUndefined();
    expect(history.find(3000 as TimeStamp)).toBeUndefined();
    expect(await persisted()).toEqual([{ value: 'authorized', startTime: 1000, endTime: 2000 }]);

    vi.setSystemTime(4000);
    manager.update('granted');

    expect(history.find(3999 as TimeStamp)).toBeUndefined();
    expect(history.find(4000 as TimeStamp)).toBe('current');
    expect(await persisted()).toEqual([
      { value: 'current', startTime: 4000, endTime: null },
      { value: 'authorized', startTime: 1000, endTime: 2000 },
    ]);
  });

  it('keeps a resumed pending interval in memory until its own grant', async () => {
    manager.update('not-granted');
    history = await TrackingConsentHistory.init<string>(options, manager);
    history.add('current', timeStampNow());
    vi.setSystemTime(2000);
    manager.update('pending');

    expect(history.find(1000 as TimeStamp)).toBeUndefined();
    expect(history.find(2000 as TimeStamp)).toBe('current');
    expect(await persisted()).toEqual([]);

    vi.setSystemTime(3000);
    manager.update('granted');
    expect(await persisted()).toEqual([{ value: 'current', startTime: 2000, endTime: null }]);
  });

  it.each<TrackingConsent>(['pending', 'not-granted'])(
    'does not restore a value cleared while %s when consent is granted',
    async (consent) => {
      history = await TrackingConsentHistory.init<string>(options, manager);
      history.add('authorized', timeStampNow());
      vi.setSystemTime(2000);
      manager.update(consent);
      vi.setSystemTime(2500);
      history.closeActive(timeStampNow());
      vi.setSystemTime(3000);
      manager.update('granted');

      expect(history.find(3000 as TimeStamp)).toBeUndefined();
      expect((await persisted()).every((entry) => entry.endTime !== null)).toBe(true);
    }
  );

  it.each<TrackingConsent>(['pending', 'not-granted'])(
    'closes previous-process history on disk before starting in %s',
    async (consent) => {
      disk = JSON.stringify([{ value: 'previous-process', startTime: 100, endTime: null }]);
      manager.update(consent);
      history = await TrackingConsentHistory.init<string>(options, manager);
      history.add('new-process', timeStampNow());

      expect(history.find(999 as TimeStamp)).toBe('previous-process');
      expect(await persisted()).toEqual([{ value: 'previous-process', startTime: 100, endTime: 1000 }]);

      history.stop();
      vi.setSystemTime(2000);
      history = await TrackingConsentHistory.init<string>(options, new TrackingConsentManager());
      expect(history.find(999 as TimeStamp)).toBe('previous-process');
      expect(history.find(1000 as TimeStamp)).toBeUndefined();
    }
  );

  it('does not record a rejected interval when rejection and grant share a timestamp', async () => {
    history = await TrackingConsentHistory.init<string>(options, manager);
    history.add('authorized', timeStampNow());
    vi.setSystemTime(2000);
    manager.update('pending');
    history.closeAndAdd('current', timeStampNow());
    vi.setSystemTime(3000);
    manager.update('not-granted');
    manager.update('granted');

    expect(history.find(2999 as TimeStamp)).toBeUndefined();
    expect(history.find(3000 as TimeStamp)).toBe('current');
    expect(await persisted()).toEqual([
      { value: 'current', startTime: 3000, endTime: null },
      { value: 'authorized', startTime: 1000, endTime: 2000 },
    ]);
  });

  it('unsubscribes from consent changes when stopped', async () => {
    history = await TrackingConsentHistory.init<string>(options, manager);
    history.add('authorized', timeStampNow());
    await persisted();
    history.stop();
    vi.mocked(fs.writeFile).mockClear();
    manager.update('pending');
    await persisted();

    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
