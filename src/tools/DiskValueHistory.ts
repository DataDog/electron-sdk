import * as fs from 'node:fs/promises';
import type { TimeStamp } from '@datadog/browser-core';
import { TimeStampValueHistory, type TimeStampHistoryEntry } from './TimeStampValueHistory';
import { displayError } from './display';

/**
 * Disk-backed extension of TimeStampValueHistory. All in-memory operations delegate to an
 * underlying TimeStampValueHistory; add() and closeActive() additionally persist the full
 * entry list to disk as a JSON array (newest-first).
 *
 * Lifecycle:
 * - Create instances via `DiskValueHistory.init()` which loads and restores entries from a
 *   previous run. Expired closed entries are pruned during init using the same threshold as add().
 *
 * Disk format: active entries (endTime = Infinity in memory) are stored as `endTime: null` on
 * disk, because JSON.stringify converts Infinity to null. On load, entries with `endTime: null`
 * are restored as active (endTime = Infinity).
 *
 * Error handling: write failures are logged via displayError and do not throw.
 * Read/parse failures leave the history empty (silent fallback).
 */
export class DiskValueHistory<T> {
  private readonly history: TimeStampValueHistory<T>;
  private readonly filePath: string;

  private constructor(history: TimeStampValueHistory<T>, filePath: string) {
    this.history = history;
    this.filePath = filePath;
  }

  static async init<T>(opts: { filePath: string; expireDelay: number }): Promise<DiskValueHistory<T>> {
    let parsedFile: unknown;
    try {
      const content = await fs.readFile(opts.filePath, 'utf-8');
      parsedFile = JSON.parse(content);
    } catch {
      // if something goes wrong, we start with an empty history
    }
    const history = new TimeStampValueHistory<T>({ expireDelay: opts.expireDelay });
    if (!Array.isArray(parsedFile)) {
      return new DiskValueHistory(history, opts.filePath);
    }

    const rawEntries = parsedFile as TimeStampHistoryEntry<T>[];
    const expireThreshold = Date.now() - opts.expireDelay;

    // Iterate oldest-to-newest to rebuild history in chronological order
    for (let i = rawEntries.length - 1; i >= 0; i--) {
      const entry = rawEntries[i];
      // Skip entries that would be immediately pruned
      if (entry.endTime !== null && (entry.endTime as number) < expireThreshold) continue;
      history.add(entry.value, entry.startTime);
      if (entry.endTime !== null) {
        history.closeActive(entry.endTime);
      }
    }

    return new DiskValueHistory(history, opts.filePath);
  }

  add(value: T, startTime: TimeStamp): void {
    this.history.add(value, startTime);
    this.persistToDisk();
  }

  find(startTime: TimeStamp): T | undefined {
    return this.history.find(startTime);
  }

  closeActive(endTime: TimeStamp): void {
    this.history.closeActive(endTime);
    this.persistToDisk();
  }

  getEntries(): readonly TimeStampHistoryEntry<T>[] {
    return this.history.getEntries();
  }

  private persistToDisk(): void {
    fs.writeFile(this.filePath, JSON.stringify(this.history.getEntries()), 'utf-8').catch((error) => {
      displayError('Failed to persist value history:', error);
    });
  }
}
