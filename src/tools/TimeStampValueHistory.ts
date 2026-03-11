import type { TimeStamp } from '@datadog/browser-core';

export interface TimeStampHistoryEntry<T> {
  startTime: TimeStamp;
  endTime: TimeStamp | null; // null = still active
  value: T;
}

/**
 * Store and keep track of values over time. Assumes values are added in chronological order
 * (i.e. all entries have an increasing startTime) with non-overlapping active periods.
 *
 * Find semantics (newest-first):
 * Return the first entry where entry.startTime <= startTime.
 *
 * Pruning: expired closed entries (endTime < Date.now() - expireDelay) are pruned on add().
 */
export class TimeStampValueHistory<T> {
  // Entries stored newest-first
  private entries: TimeStampHistoryEntry<T>[] = [];
  private expireDelay: number;

  constructor(opts: { expireDelay: number }) {
    this.expireDelay = opts.expireDelay;
  }

  add(value: T, startTime: TimeStamp): void {
    this.pruneExpiredValues();
    this.entries.unshift({ startTime, endTime: null, value });
  }

  find(startTime: TimeStamp): T | undefined {
    for (const entry of this.entries) {
      if (entry.startTime <= startTime) {
        return entry.value;
      }
    }

    return undefined;
  }

  closeActive(endTime: TimeStamp): void {
    // Active entry is always the most recently added (index 0)
    const latestEntry = this.entries[0];
    if (latestEntry && latestEntry.endTime === null) {
      latestEntry.endTime = endTime;
    }
  }

  getEntries(): readonly TimeStampHistoryEntry<T>[] {
    return this.entries;
  }

  private pruneExpiredValues(): void {
    const oldTimeThreshold = Date.now() - this.expireDelay;
    while (this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1];
      if (last.endTime !== null && last.endTime < oldTimeThreshold) {
        this.entries.pop();
      } else {
        break;
      }
    }
  }
}
