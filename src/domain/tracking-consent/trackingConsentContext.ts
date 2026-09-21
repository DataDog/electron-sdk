import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import type { TimeStamp } from '@datadog/js-core/time';
import type { FormatHooks } from '../../assembly';
import type { TrackingConsentState } from './trackingConsentState';

/**
 * Drop formats that are not tied to the sampled-session history while collection is disabled.
 *
 * RUM, spans, profiles, and replay are already gated by the session covering their capture time. Logs
 * and telemetry have no equivalent session gate, so resolve consent from the supplied context time
 * (capture time for main-process events, receipt time for bridged logs/telemetry).
 */
export function registerTrackingConsentContext(hooks: FormatHooks, state: TrackingConsentState): void {
  const discardWithoutConsent = ({ startTime }: { startTime: TimeStamp }) =>
    state.getAt(startTime) === 'granted' || state.getAt(startTime) === 'pending' ? SKIPPED : DISCARDED;

  hooks.registerTelemetry(discardWithoutConsent);
  hooks.registerLogs(discardWithoutConsent);
}
