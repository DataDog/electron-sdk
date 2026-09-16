import { Observable } from '@datadog/browser-core';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import type { TrackingConsent } from '../../config';

export interface TrackingConsentChange {
  previous: TrackingConsent;
  current: TrackingConsent;
}

export interface TrackingConsentState {
  tryToInit(trackingConsent: TrackingConsent): void;
  update(trackingConsent: TrackingConsent): void;
  get(): TrackingConsent | undefined;
  isGranted(): boolean;
  isPending(): boolean;
  isCollectionEnabled(): boolean;
  getAt(at: TimeStamp): TrackingConsent | undefined;
  resolveForStorage(at: TimeStamp): TrackingConsent | undefined;
  beforeObservable: Observable<TrackingConsentChange>;
  observable: Observable<TrackingConsentChange>;
  onCollectionAuthorizedOnce(callback: () => void): void;
}

/**
 * Process-wide consent state. A value set through the public API before init wins over the
 * configuration passed to init, matching the Browser SDK contract.
 */
export function createTrackingConsentState(initialConsent?: TrackingConsent): TrackingConsentState {
  let currentConsent = initialConsent;
  const history: ConsentHistoryEntry[] = [];
  const beforeObservable = new Observable<TrackingConsentChange>();
  const observable = new Observable<TrackingConsentChange>();

  if (initialConsent !== undefined) {
    history.unshift({ consent: initialConsent, startTime: -Infinity as TimeStamp, endTime: Infinity as TimeStamp });
  }

  const isGranted = () => currentConsent === 'granted';
  const isPending = () => currentConsent === 'pending';
  const isCollectionEnabled = () => isGranted() || isPending();

  return {
    tryToInit(trackingConsent) {
      if (currentConsent === undefined) {
        currentConsent = trackingConsent;
        history.unshift({
          consent: trackingConsent,
          startTime: -Infinity as TimeStamp,
          endTime: Infinity as TimeStamp,
        });
      }
    },
    update(trackingConsent) {
      if (trackingConsent === currentConsent) {
        return;
      }
      const previous = currentConsent;
      const transitionTime = timeStampNow();
      const activeEntry = history[0];
      if (activeEntry) {
        activeEntry.endTime = transitionTime;
      }
      history.unshift({ consent: trackingConsent, startTime: transitionTime, endTime: Infinity as TimeStamp });
      currentConsent = trackingConsent;
      if (previous !== undefined) {
        const change = { previous, current: trackingConsent };
        // Storage must reserve its clear/migration before lifecycle observers can synchronously emit events.
        beforeObservable.notify(change);
        observable.notify(change);
      }
    },
    get: () => currentConsent,
    isGranted,
    isPending,
    isCollectionEnabled,
    getAt: (at) => findConsentEntry(history, at)?.consent,
    resolveForStorage(at) {
      const index = history.findIndex((entry) => entry.startTime <= at && at < entry.endTime);
      if (index === -1) {
        return undefined;
      }
      const entry = history[index];
      if (entry.consent !== 'pending' || entry.endTime === Infinity) {
        return entry.consent;
      }
      // Entries are newest-first. The entry immediately before this one is the state that resolved
      // the pending interval and determines whether its data was authorized or rejected.
      return history[index - 1]?.consent === 'granted' ? 'granted' : 'not-granted';
    },
    beforeObservable,
    observable,
    onCollectionAuthorizedOnce(callback) {
      let reportedInPending = false;
      const subscription = observable.subscribe((change) => {
        if (change.previous === 'pending' && change.current === 'granted' && reportedInPending) {
          subscription.unsubscribe();
          return;
        }
        if (change.previous === 'pending' && change.current === 'not-granted') {
          reportedInPending = false;
        }
        if (change.current === 'granted') {
          callback();
          subscription.unsubscribe();
        } else if (change.current === 'pending' && !reportedInPending) {
          callback();
          reportedInPending = true;
        }
      });

      if (isGranted()) {
        callback();
        subscription.unsubscribe();
      } else if (isPending()) {
        callback();
        reportedInPending = true;
      }
    },
  };
}

interface ConsentHistoryEntry {
  consent: TrackingConsent;
  startTime: TimeStamp;
  endTime: TimeStamp;
}

function findConsentEntry(history: ConsentHistoryEntry[], at: TimeStamp): ConsentHistoryEntry | undefined {
  return history.find((entry) => entry.startTime <= at && at < entry.endTime);
}
