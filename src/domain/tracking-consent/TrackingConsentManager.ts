import { Observable, type Subscription } from '@datadog/browser-core';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { TimeStampValueHistory } from '../../tools/TimeStampValueHistory';
import { monitor } from '../telemetry';

/**
 * Owns the internal consent state and its in-memory history for one SDK instance.
 * Observers run synchronously after a transition.
 * Collection and storage remain the responsibility of consumers.
 */
export class TrackingConsentManager {
  private readonly history = new TimeStampValueHistory<TrackingConsent>({ expireDelay: Infinity });
  private readonly changes = new Observable<TrackingConsentChange>();

  constructor() {
    this.history.add('granted', timeStampNow());
  }

  get(): TrackingConsent {
    return this.history.find(timeStampNow())!;
  }

  /** Original consent at capture time, or undefined before this manager was created. */
  getAt(time: TimeStamp): TrackingConsent | undefined {
    return this.history.find(time);
  }

  /** Update the state and notify subscribers. Repeating the active state has no effect. */
  update(consent: TrackingConsent): void {
    const previous = this.get();
    if (consent === previous) {
      return;
    }

    const time = timeStampNow();
    this.history.closeActive(time);
    this.history.add(consent, time);
    this.changes.notify({ previous, current: consent, time });
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
