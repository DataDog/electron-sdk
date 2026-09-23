import { TrackingConsentManager } from './TrackingConsentManager';

const trackingConsentManager = new TrackingConsentManager();

/** Shared dependency for main SDK components; not part of the public package API. */
export function getTrackingConsentManager(): TrackingConsentManager {
  return trackingConsentManager;
}
