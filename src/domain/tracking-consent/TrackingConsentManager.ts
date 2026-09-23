import { Observable, type Subscription } from '@datadog/browser-core';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { TimeStampValueHistory } from '../../tools/TimeStampValueHistory';
import { monitor } from '../telemetry';

/**
 * Owns the internal consent state and its in-memory history for one SDK instance.
 * Observers run synchronously after a transition; reentrant updates wait until every observer
 * has received that transition. Collection and storage remain the responsibility of consumers.
 */
export class TrackingConsentManager {
  private readonly history = new TimeStampValueHistory<TrackingConsent>({ expireDelay: Infinity });
  private readonly changes = new Observable<TrackingConsentChange>();
  private readonly queuedUpdates: TrackingConsent[] = [];
  private isUpdating = false;

  constructor() {
    this.history.add('granted', timeStampNow());
  }

  get(): TrackingConsent {
    return this.history.getEntries()[0].value;
  }

  /** Original consent at capture time, or undefined before this manager was created. */
  getAt(time: TimeStamp): TrackingConsent | undefined {
    return this.history.find(time);
  }

  /** Apply each requested state in order. Repeating the active state has no effect. */
  update(consent: TrackingConsent): void {
    this.queuedUpdates.push(consent);
    if (this.isUpdating) {
      return;
    }

    this.isUpdating = true;
    try {
      let current: TrackingConsent | undefined;
      while ((current = this.queuedUpdates.shift()) !== undefined) {
        const previous = this.get();
        if (current === previous) {
          continue;
        }

        const time = timeStampNow();
        this.history.closeActive(time);
        this.history.add(current, time);
        this.changes.notify({ previous, current, time });
      }
    } finally {
      this.isUpdating = false;
    }
  }

  /** Subscribe to future changes. A failing observer must not interrupt other consumers. */
  subscribe(callback: (change: TrackingConsentChange) => void): Subscription {
    return this.changes.subscribe(monitor(callback));
  }
}

export type TrackingConsent = 'granted' | 'pending' | 'not-granted';

export interface TrackingConsentChange {
  readonly previous: TrackingConsent;
  readonly current: TrackingConsent;
  readonly time: TimeStamp;
}
