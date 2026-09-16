import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import type { FormatHooks } from '../../assembly';
import type { TrackingConsentState } from './trackingConsentState';

/**
 * Drop formats that are not tied to the sampled-session history while collection is disabled.
 *
 * RUM, spans, profiles, and replay are already gated by the session covering their capture time. Logs
 * and telemetry have no equivalent session gate, so remember the point where collection became enabled.
 */
export function registerTrackingConsentContext(hooks: FormatHooks, state: TrackingConsentState): void {
  // Renderer messages can already be queued in IPC when consent changes. Remember the latest collection
  // boundary so an event captured under `not-granted` cannot become eligible merely because it reaches
  // the main process after moving to `pending` or `granted`.
  let wasCollectionEnabled = state.isCollectionEnabled();
  let collectionStartedAt: TimeStamp | undefined = wasCollectionEnabled ? timeStampNow() : undefined;
  state.observable.subscribe(() => {
    const isCollectionEnabled = state.isCollectionEnabled();
    if (isCollectionEnabled && !wasCollectionEnabled) {
      collectionStartedAt = timeStampNow();
    } else if (!isCollectionEnabled) {
      collectionStartedAt = undefined;
    }
    wasCollectionEnabled = isCollectionEnabled;
  });

  const discardWithoutConsent = ({ startTime }: { startTime: TimeStamp }) =>
    collectionStartedAt !== undefined && startTime >= collectionStartedAt ? SKIPPED : DISCARDED;

  hooks.registerTelemetry(discardWithoutConsent);
  hooks.registerLogs(discardWithoutConsent);
}
