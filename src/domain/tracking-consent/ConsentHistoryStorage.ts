import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TimeStamp } from '@datadog/js-core/time';
import { isIndexableObject } from '@datadog/js-core/util';
import type { TimeStampHistoryEntry } from '../../tools/TimeStampValueHistory';
import { display } from '../../tools/display';
import { monitor } from '../telemetry';
import type { TrackingConsent } from './TrackingConsentManager';

type ConsentEntry = TimeStampHistoryEntry<TrackingConsent>;

/** Loads the previous launch's consent and serializes snapshots from the current launch. */
export class ConsentHistoryStorage {
  private readonly filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(basePath: string) {
    this.filePath = path.join(basePath, '_dd_tracking_consent_history');
  }

  async load(launchTime: TimeStamp): Promise<ConsentEntry[]> {
    try {
      const stored: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf-8'));
      if (!Array.isArray(stored)) throw new Error('Invalid tracking consent history');

      const entries: ConsentEntry[] = [];
      let nextStart = launchTime;
      for (const [index, entry] of stored.entries()) {
        if (
          !isIndexableObject(entry) ||
          !isConsent(entry.value) ||
          typeof entry.startTime !== 'number' ||
          !Number.isFinite(entry.startTime) ||
          entry.startTime > nextStart ||
          (entry.endTime === null
            ? index !== 0
            : typeof entry.endTime !== 'number' ||
              !Number.isFinite(entry.endTime) ||
              entry.endTime < entry.startTime ||
              entry.endTime > nextStart ||
              (index > 0 && entry.endTime !== nextStart))
        ) {
          throw new Error('Invalid tracking consent history');
        }
        entries.push({
          value: entry.value,
          startTime: entry.startTime as TimeStamp,
          endTime: (entry.endTime === null ? launchTime : entry.endTime) as TimeStamp,
        });
        nextStart = entry.startTime as TimeStamp;
      }
      return entries;
    } catch (error) {
      if (!isIndexableObject(error) || error.code !== 'ENOENT') {
        display.error('Failed to load tracking consent history:', error);
      }
      return [];
    }
  }

  save(entries: readonly ConsentEntry[]): void {
    const snapshot = JSON.stringify(entries);
    this.pendingWrite = this.pendingWrite.then(
      monitor(async () => {
        try {
          await fs.writeFile(this.filePath, snapshot, 'utf-8');
        } catch (error) {
          display.error('Failed to persist tracking consent history:', error);
        }
      })
    );
  }

  flush(): Promise<void> {
    return this.pendingWrite;
  }
}

function isConsent(value: unknown): value is TrackingConsent {
  return value === 'granted' || value === 'pending' || value === 'not-granted';
}
