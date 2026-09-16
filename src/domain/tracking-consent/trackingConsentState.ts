import { Observable } from '@datadog/browser-core';
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
  observable: Observable<TrackingConsentChange>;
  onCollectionEnabledOnce(callback: () => void): void;
}

/**
 * Process-wide consent state. A value set through the public API before init wins over the
 * configuration passed to init, matching the Browser SDK contract.
 */
export function createTrackingConsentState(initialConsent?: TrackingConsent): TrackingConsentState {
  let currentConsent = initialConsent;
  const observable = new Observable<TrackingConsentChange>();

  const isGranted = () => currentConsent === 'granted';
  const isPending = () => currentConsent === 'pending';
  const isCollectionEnabled = () => isGranted() || isPending();

  return {
    tryToInit(trackingConsent) {
      if (currentConsent === undefined) {
        currentConsent = trackingConsent;
      }
    },
    update(trackingConsent) {
      if (trackingConsent === currentConsent) {
        return;
      }
      const previous = currentConsent;
      currentConsent = trackingConsent;
      if (previous !== undefined) {
        observable.notify({ previous, current: trackingConsent });
      }
    },
    get: () => currentConsent,
    isGranted,
    isPending,
    isCollectionEnabled,
    observable,
    onCollectionEnabledOnce(callback) {
      if (isCollectionEnabled()) {
        callback();
        return;
      }
      const subscription = observable.subscribe(() => {
        if (isCollectionEnabled()) {
          callback();
          subscription.unsubscribe();
        }
      });
    },
  };
}
