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
  resolveForStorageInterval(start: TimeStamp, end: TimeStamp): TrackingConsent | undefined;
  /** Notified synchronously while the previous consent is still active. */
  boundaryObservable: Observable<TrackingConsentChange>;
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
  const boundaryObservable = new Observable<TrackingConsentChange>();
  const beforeObservable = new Observable<TrackingConsentChange>();
  const observable = new Observable<TrackingConsentChange>();
  const queuedUpdates: TrackingConsent[] = [];
  let isUpdating = false;

  if (initialConsent !== undefined) {
    history.unshift({ consent: initialConsent, startTime: -Infinity as TimeStamp, endTime: Infinity as TimeStamp });
  }

  const isGranted = () => currentConsent === 'granted';
  const isPending = () => currentConsent === 'pending';
  const isCollectionEnabled = () => isGranted() || isPending();

  const update = (trackingConsent: TrackingConsent) => {
    queuedUpdates.push(trackingConsent);
    if (isUpdating) {
      return;
    }

    isUpdating = true;
    try {
      let nextConsent: TrackingConsent | undefined;
      while ((nextConsent = queuedUpdates.shift()) !== undefined) {
        if (nextConsent === currentConsent) {
          continue;
        }
        const previous = currentConsent;
        const transitionTime = timeStampNow();
        if (previous !== undefined) {
          // Give cumulative collectors a chance to snapshot the interval that is ending. Keeping the
          // previous state active during this notification also routes that snapshot to the right store.
          boundaryObservable.notify({ previous, current: nextConsent });
        }
        const activeEntry = history[0];
        if (activeEntry) {
          activeEntry.endTime = transitionTime;
        }
        history.unshift({ consent: nextConsent, startTime: transitionTime, endTime: Infinity as TimeStamp });
        currentConsent = nextConsent;
        if (previous !== undefined) {
          const change = { previous, current: nextConsent };
          // Storage must reserve its clear/migration before lifecycle observers can synchronously emit events.
          beforeObservable.notify(change);
          observable.notify(change);
        }
      }
    } finally {
      isUpdating = false;
    }
  };

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
    update,
    get: () => currentConsent,
    isGranted,
    isPending,
    isCollectionEnabled,
    getAt: (at) => findConsentEntry(history, at)?.consent,
    resolveForStorage(at) {
      return resolveEntryForStorage(
        history,
        history.findIndex((entry) => entry.startTime <= at && at < entry.endTime)
      );
    },
    resolveForStorageInterval(start, end) {
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return undefined;
      }
      const intervalStart = Math.min(start, end) as TimeStamp;
      const intervalEnd = Math.max(start, end) as TimeStamp;
      let result: TrackingConsent | undefined;

      for (const [index, entry] of history.entries()) {
        // Include the state active at the completion instant as well as every state crossed by the interval.
        if (entry.startTime > intervalEnd || entry.endTime <= intervalStart) {
          continue;
        }
        const consent = resolveEntryForStorage(history, index);
        if (consent === 'not-granted') {
          return consent;
        }
        if (consent === 'pending') {
          result = consent;
        } else if (result === undefined) {
          result = consent;
        }
      }

      return result;
    },
    boundaryObservable,
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

function resolveEntryForStorage(history: ConsentHistoryEntry[], index: number): TrackingConsent | undefined {
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
}
