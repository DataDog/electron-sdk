import type { Subscription } from '@datadog/browser-core';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { DiskValueHistory } from '../../tools/DiskValueHistory';
import type { TrackingConsentChange, TrackingConsentManager } from './TrackingConsentManager';

/**
 * Keeps attribution history in memory while consent is pending and persists it only after a grant.
 * Rejected intervals are discarded without erasing earlier authorized history. The latest value
 * remains available to start a new interval when consent permits tracking again.
 */
export class TrackingConsentHistory<T> {
  private readonly subscription: Subscription;
  private currentValue: T | undefined;

  private constructor(
    private readonly history: DiskValueHistory<T>,
    private readonly consentManager: TrackingConsentManager
  ) {
    if (consentManager.get() !== 'granted') {
      history.pausePersistence();
    }
    this.subscription = consentManager.subscribe((change) => this.onConsentChange(change));
  }

  /** Loads authorized history and closes the previous process's interval before applying consent. */
  static async init<T>(
    options: { filePath: string; expireDelay: number },
    consentManager: TrackingConsentManager
  ): Promise<TrackingConsentHistory<T>> {
    const history = await DiskValueHistory.init<T>(options);
    history.closeActive(timeStampNow());
    return new TrackingConsentHistory(history, consentManager);
  }

  add(value: T, startTime: TimeStamp): void {
    this.currentValue = value;
    if (this.consentManager.get() !== 'not-granted') {
      this.history.add(value, startTime);
    }
  }

  closeActive(endTime: TimeStamp): void {
    this.currentValue = undefined;
    if (this.consentManager.get() !== 'not-granted') {
      this.history.closeActive(endTime);
    }
  }

  closeAndAdd(value: T, atTime: TimeStamp): void {
    this.currentValue = value;
    if (this.consentManager.get() !== 'not-granted') {
      this.history.closeAndAdd(value, atTime);
    }
  }

  pruneAndPersist(): void {
    if (this.consentManager.get() !== 'not-granted') {
      this.history.pruneAndPersist();
    }
  }

  find(atTime: TimeStamp): T | undefined {
    return this.history.find(atTime);
  }

  /** Releases the consent subscription owned by this history. */
  stop(): void {
    this.subscription.unsubscribe();
  }

  private onConsentChange(change: TrackingConsentChange): void {
    if (change.previous === 'granted') {
      try {
        this.history.closeActive(change.time);
      } finally {
        // Closing may fail to serialize customer data. That must never allow pending writes to disk.
        this.history.pausePersistence();
      }
    } else if (change.previous === 'pending' && change.current === 'granted') {
      this.history.commitPausedChanges();
      return;
    } else {
      this.history.discardPausedChanges();
      if (change.current !== 'granted') {
        this.history.pausePersistence();
      }
    }

    if (change.current !== 'not-granted' && this.currentValue !== undefined) {
      this.history.add(this.currentValue, change.time);
    }
  }
}
