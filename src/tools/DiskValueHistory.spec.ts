import { mockFs } from '../mocks.specUtil';

import * as display from './display';
vi.mock('./display', () => ({
  displayError: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TimeStamp } from '@datadog/browser-core';
import { DiskValueHistory } from './DiskValueHistory';
import { TimeStampHistoryEntry } from './TimeStampValueHistory';

vi.mock('node:fs/promises');
const mfs = mockFs();

const FILE_PATH = '/test/history.json';
const EXPIRE_DELAY = 1000;

const T0 = 0 as TimeStamp;
const T10 = 10 as TimeStamp;
const T20 = 20 as TimeStamp;

describe('DiskValueHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mfs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  describe('init()', () => {
    it('starts with empty history when file does not exist', async () => {
      mfs.readFile.mockRejectedValue(new Error('ENOENT'));

      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });

      expect(history.getEntries()).toHaveLength(0);
    });

    it('starts with empty history when file contains invalid JSON', async () => {
      mfs.readFile.mockResolvedValue('not valid json');

      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });

      expect(history.getEntries()).toHaveLength(0);
    });

    it('starts with empty history when file contains valid JSON but not an array', async () => {
      mfs.readFile.mockResolvedValue(JSON.stringify({ startTime: T0, value: 'a' }));

      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });

      expect(history.getEntries()).toHaveLength(0);
    });

    it('loads entries from disk preserving startTime, endTime, and value', async () => {
      mfs.readFile.mockResolvedValue(
        JSON.stringify([
          { startTime: T10, endTime: null, value: 'session-b' },
          { startTime: T0, endTime: T10, value: 'session-a' },
        ])
      );

      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });

      const entries = history.getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ startTime: T10, endTime: Infinity, value: 'session-b' });
      expect(entries[1]).toMatchObject({ startTime: T0, endTime: T10, value: 'session-a' });
    });

    it('prunes expired closed entries on load', async () => {
      // At time 21, threshold = 21 - 10 = 11. endTime=10 < 11 → pruned; active entry is kept.
      vi.setSystemTime(21);
      mfs.readFile.mockResolvedValue(
        JSON.stringify([
          { startTime: T20, endTime: null, value: 'current' },
          { startTime: T0, endTime: T10, value: 'expired' },
        ])
      );

      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: 10 });

      expect(history.getEntries()).toHaveLength(1);
      expect(history.getEntries()[0].value).toBe('current');
    });

    it('keeps active entries regardless of age', async () => {
      vi.setSystemTime(9999);
      mfs.readFile.mockResolvedValue(JSON.stringify([{ startTime: T0, endTime: null, value: 'old-active' }]));

      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: 10 });

      expect(history.getEntries()).toHaveLength(1);
      expect(history.getEntries()[0].value).toBe('old-active');
    });

    it('active entries persist as null on disk and reload as Infinity', async () => {
      mfs.readFile.mockRejectedValue(new Error('ENOENT'));
      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });

      history.add('active-session', T0);
      await vi.advanceTimersByTimeAsync(0);

      // Disk stores Infinity as null (JSON.stringify behavior)
      const written = JSON.parse(mfs.writeFile.mock.calls[0][1] as string) as TimeStampHistoryEntry<string>[];
      expect(written[0].endTime).toBeNull();

      // Reload: null on disk → Infinity in memory
      mfs.readFile.mockResolvedValue(mfs.writeFile.mock.calls[0][1] as string);
      const reloaded = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });
      expect(reloaded.getEntries()[0].endTime).toBe(Infinity);
    });
  });

  describe('add()', () => {
    it('persists entries to disk after add', async () => {
      mfs.readFile.mockRejectedValue(new Error('ENOENT'));
      mfs.writeFile.mockResolvedValue(undefined);
      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });

      history.add('session-a', T0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mfs.writeFile).toHaveBeenCalledWith(
        FILE_PATH,
        JSON.stringify([{ startTime: T0, endTime: null, value: 'session-a' }]),
        'utf-8'
      );
    });

    it('calls displayError on write failure', async () => {
      mfs.readFile.mockRejectedValue(new Error('ENOENT'));
      mfs.writeFile.mockRejectedValue(new Error('disk full'));
      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });

      history.add('session-a', T0);
      await vi.advanceTimersByTimeAsync(0);

      expect(display.displayError).toHaveBeenCalled();
    });
  });

  describe('closeActive()', () => {
    it('persists entries to disk after closeActive', async () => {
      mfs.readFile.mockRejectedValue(new Error('ENOENT'));
      mfs.writeFile.mockResolvedValue(undefined);
      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });

      history.add('session-a', T0);
      history.closeActive(T10);
      await vi.advanceTimersByTimeAsync(0);

      const lastCall = mfs.writeFile.mock.calls[mfs.writeFile.mock.calls.length - 1] as [string, string, string];
      const written = JSON.parse(lastCall[1]) as TimeStampHistoryEntry<string>[];
      expect(written[0]).toMatchObject({ startTime: T0, endTime: T10, value: 'session-a' });
    });
  });

  describe('find()', () => {
    it('delegates to underlying TimeStampValueHistory', async () => {
      mfs.readFile.mockRejectedValue(new Error('ENOENT'));
      const history = await DiskValueHistory.init<string>({ filePath: FILE_PATH, expireDelay: EXPIRE_DELAY });

      history.add('session-a', T0);

      expect(history.find(T10)).toBe('session-a');
    });
  });
});
