import type { TimeStamp } from '@datadog/js-core/time';
import { TimeStampValueHistory, type TimeStampHistoryEntry } from '../../tools/TimeStampValueHistory';
import type { DiskStorage } from '../../tools/DiskStorage';
import type { TrackingConsent, TrackingConsentChange } from './TrackingConsentManager';

/**
 * Keeps context available for delayed events without persisting undecided changes.
 * Refusal removes pending history; the latest configured value can still be used when tracking resumes.
 */
export class TrackingConsentHistory<T> {
  private readonly history: TimeStampValueHistory<T>;
  private authorizedEntries: TimeStampHistoryEntry<T>[];
  private latestValue: T | undefined;
  private consent: TrackingConsent;

  constructor(
    private readonly storage: DiskStorage<readonly TimeStampHistoryEntry<T>[]>,
    options: {
      entries: readonly TimeStampHistoryEntry<T>[] | undefined;
      expireDelay: number;
      consent: TrackingConsent;
      startTime: TimeStamp;
    }
  ) {
    this.history = new TimeStampValueHistory({ expireDelay: options.expireDelay });
    this.consent = options.consent;
    if (Array.isArray(options.entries)) {
      // JSON stores the open-ended Infinity bound as null. Restore the existing file format.
      const entries = options.entries as readonly TimeStampHistoryEntry<T>[];
      for (const entry of [...entries].reverse()) {
        this.history.add(entry.value, entry.startTime);
        if (entry.endTime !== null) this.history.closeActive(entry.endTime);
      }
    }
    // Loaded values describe the previous process; they must not become the current context.
    this.history.closeActive(options.startTime);
    this.history.pruneExpired();
    this.authorizedEntries = this.copyEntries();
    this.storage.save(this.authorizedEntries);
  }

  /** Records a new value, or ends the current value when it is cleared. */
  set(value: T | undefined, atTime: TimeStamp): void {
    this.latestValue = value;
    if (this.consent === 'not-granted') return;

    this.history.closeActive(atTime);
    if (value !== undefined) this.history.add(value, atTime);
    this.history.pruneExpired();
    if (this.consent === 'granted') this.storage.save(this.history.getEntries());
  }

  find(atTime: TimeStamp): T | undefined {
    return this.history.find(atTime);
  }

  /** Called by the factory before collectors react to the same consent change. */
  updateConsent(change: TrackingConsentChange): void {
    this.consent = change.current;
    if (change.previous === 'granted') {
      this.history.closeActive(change.time);
      this.authorizedEntries = this.copyEntries();
      if (change.current === 'pending' && this.latestValue !== undefined) {
        this.history.add(this.latestValue, change.time);
      }
      // Finish the in-memory transition first: serialization failure must not enable pending writes.
      this.storage.save(this.authorizedEntries);
    } else if (change.previous === 'pending' && change.current === 'granted') {
      this.storage.save(this.history.getEntries());
    } else {
      this.history.replaceEntries(this.authorizedEntries);
      if (change.current !== 'not-granted' && this.latestValue !== undefined) {
        this.history.add(this.latestValue, change.time);
      }
      if (change.current === 'granted') this.storage.save(this.history.getEntries());
    }
  }

  private copyEntries(): TimeStampHistoryEntry<T>[] {
    return this.history.getEntries().map((entry) => ({ ...entry }));
  }
}
