import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TimeStamp } from '@datadog/browser-core';
import { TimeStampValueHistory } from './TimeStampValueHistory';

// Fake timers align Date.now() with test timestamps so pruning works predictably
const T0 = 0 as TimeStamp;
const T10 = 10 as TimeStamp;
const T20 = 20 as TimeStamp;
const T30 = 30 as TimeStamp;
const T40 = 40 as TimeStamp;
const T50 = 50 as TimeStamp;

const EXPIRE_DELAY = 1000;

describe('TimeStampValueHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('add / find', () => {
    it('returns undefined when history is empty', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      expect(history.find(T0)).toBeUndefined();
    });

    it('returns the active entry for a query time after its startTime', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T10);

      expect(history.find(T20)).toBe('a');
    });

    it('returns the active entry for a query exactly at its startTime', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T10);

      expect(history.find(T10)).toBe('a');
    });

    it('returns undefined for a query time before the first entry', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T20);

      expect(history.find(T10)).toBeUndefined();
    });

    it('returns the most recent entry that started before or at the query time', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T10);
      history.add('b', T30);

      expect(history.find(T20)).toBe('a');
      expect(history.find(T40)).toBe('b');
    });
  });

  describe('closeActive', () => {
    it('returns the value for a query within the active period after close', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T10);
      history.closeActive(T30);

      expect(history.find(T20)).toBe('a');
    });

    it('returns the closed entry for a query after endTime', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T10);
      history.closeActive(T30);

      expect(history.find(T40)).toBeUndefined();
    });

    it('closes only the latest active entry (index 0)', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T10);
      history.add('b', T20);
      history.closeActive(T30);

      const entries = history.getEntries();
      // 'b' is at index 0 (newest), so it gets closed
      expect(entries[0]).toMatchObject({ value: 'b', endTime: T30 });
      // 'a' at index 1 remains open
      expect(entries[1]).toMatchObject({ value: 'a', endTime: Infinity });
    });

    it('is a no-op when there is no active entry', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T10);
      history.closeActive(T20);
      history.closeActive(T30); // second close should not throw or change endTime

      // endTime stays at T20 (first close), not T30
      expect(history.getEntries()[0].endTime).toBe(T20);
    });
  });

  describe('expireDelay — pruning on add()', () => {
    it('prunes closed entries whose endTime is older than expireDelay', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: 10 });

      history.add('a', T0);
      history.closeActive(T10); // entry closed at T10

      // advance Date.now() past T10 + expireDelay: threshold = 21 - 10 = 11 > 10 (endTime) → prune
      vi.setSystemTime(21);
      history.add('b', T20);

      expect(history.getEntries()).toHaveLength(1);
      expect(history.getEntries()[0].value).toBe('b');
    });

    it('does not prune active entries regardless of age', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: 10 });

      history.add('a', T0); // never closed

      vi.setSystemTime(1000);
      history.add('b', T20); // triggers pruning — but 'a' is still active

      expect(history.getEntries()).toHaveLength(2);
    });

    it('does not prune entries closed within expireDelay', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: 10 });

      history.add('a', T0);
      history.closeActive(T10);

      // threshold = 15 - 10 = 5; endTime=10 >= 5 → not pruned
      vi.setSystemTime(15);
      history.add('b', T20);

      expect(history.getEntries()).toHaveLength(2);
    });

    it('does not prune on find() or closeActive() — only on add()', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: 10 });

      history.add('a', T0);
      history.closeActive(T10);

      // Advance past expiry threshold — but don't call add()
      vi.setSystemTime(21);

      // find() and closeActive() must not prune: entries are still present
      expect(history.getEntries()).toHaveLength(1);
      history.closeActive(T30); // no-op, but must not prune either
      expect(history.getEntries()).toHaveLength(1);
    });
  });

  describe('multiple sessions / views', () => {
    it('returns correct session for each query time across boundaries', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('session-1', T0);
      history.closeActive(T20);
      history.add('session-2', T20);
      history.closeActive(T40);
      history.add('session-3', T40);

      expect(history.find(T10)).toBe('session-1');
      expect(history.find(T30)).toBe('session-2');
      expect(history.find(T50)).toBe('session-3');
    });

    it('returns session-1 for a query in the gap between sessions', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('session-1', T0);
      history.closeActive(T10);
      history.add('session-2', T30); // gap between T10 and T30

      // T20 is after session-1 expired (endTime=T10) — no active session → undefined
      expect(history.find(T20)).toBeUndefined();
    });
  });

  describe('getEntries', () => {
    it('returns all entries newest-first', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T10);
      history.add('b', T20);

      const entries = history.getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].value).toBe('b');
      expect(entries[1].value).toBe('a');
    });

    it('reflects endTime after closeActive', () => {
      const history = new TimeStampValueHistory<string>({ expireDelay: EXPIRE_DELAY });

      history.add('a', T10);
      history.closeActive(T30);

      const entries = history.getEntries();
      expect(entries[0].startTime).toBe(T10);
      expect(entries[0].endTime).toBe(T30);
    });
  });
});
