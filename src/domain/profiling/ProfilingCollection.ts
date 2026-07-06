import { combine } from '@datadog/js-core/util';
import { SKIPPED } from '@datadog/js-core/assembly';
import type { TimeStamp } from '@datadog/js-core/time';
import type { Configuration } from '../../config';
import type { FormatHooks, RumEventType } from '../../assembly';
import type { SessionManager } from '../session';
import { EventKind, EventFormat, EventSource, EventTrack } from '../../event';
import type { EventManager, RawProfileEvent, ServerProfileEvent } from '../../event';
import { correctedChildSampleRate, isSessionSampled } from '../../tools/Sampler';

// The browser SDK attaches its profiling context only to these event types (see the browser SDK's
// profilingContext assemble hook), so electron scopes its contribution the same way to stay consistent.
const PROFILING_EVENT_TYPES: readonly RumEventType[] = ['view', 'long_task', 'action', 'vital'];

export class ProfilingCollection {
  constructor(
    eventManager: EventManager,
    private readonly sessionManager: Pick<SessionManager, 'getTrackedSessionId'>,
    private readonly config: Configuration,
    hooks: FormatHooks
  ) {
    // Enrich renderer RUM events with the profiling context electron is authoritative for. The renderer
    // (browser SDK) owns `status`/`error_reason`; electron suppresses the context for sessions it sampled
    // out. See the Profiling / Error Reporting notes in docs/ARCHITECTURE.md.
    hooks.registerRum(({ source, eventType, startTime }) => {
      if (source !== EventSource.RENDERER || !PROFILING_EVENT_TYPES.includes(eventType)) {
        return SKIPPED;
      }
      // Resolve the session that produced the event from its start time (as SessionContext does for
      // `session.id`), so a delayed event crossing a renewal keeps the profiling context of its own session
      // rather than the current one.
      const sessionId = this.sessionManager.getTrackedSessionId(startTime);
      if (sessionId === undefined) {
        return SKIPPED; // no tracked session covered this event; SessionContext discards it
      }
      if (!this.isProfilingSampled(sessionId)) {
        // The renderer profiles regardless of electron's per-session sampling (the PROFILES capability is
        // advertised globally), so it sets a context here. Override it: `combine` cannot delete a key, and
        // `null` is equivalent to absent for the backend (a sampled-out session links no profile, so
        // `has_profile` stays false either way).
        return { _dd: { profiling: null } };
      }
      return SKIPPED;
    });

    eventManager.registerHandler<RawProfileEvent>({
      canHandle: (event): event is RawProfileEvent =>
        event.kind === EventKind.RAW && event.format === EventFormat.PROFILE,
      handle: (rawEvent, notify) => {
        const serverEvent = this.processProfile(rawEvent);
        if (serverEvent) notify(serverEvent);
      },
    });
  }

  private isProfilingSampled(sessionId: string): boolean {
    return isSessionSampled(
      sessionId,
      correctedChildSampleRate(this.config.sessionSampleRate, this.config.profilingSampleRate)
    );
  }

  private processProfile(rawEvent: RawProfileEvent): ServerProfileEvent | null {
    // Attribute the profile to the session that produced it, not the current one: a profile can be flushed
    // asynchronously (e.g. on unload) after the session renewed or expired. Resolve the session covering the
    // profile's start time from the session history (like RUM events do via their start time), and drop the
    // profile if none covered it (window expired, or the session was not sampled). Sampling for that session
    // is re-derived from its id so the decision matches the one that captured the profile.
    const captureTime = new Date(rawEvent.data.start).getTime() as TimeStamp;
    const sessionId = this.sessionManager.getTrackedSessionId(captureTime);
    if (sessionId === undefined || !this.isProfilingSampled(sessionId)) {
      return null;
    }

    return {
      kind: EventKind.SERVER,
      track: EventTrack.PROFILE,
      data: combine(rawEvent.data, {
        session: { id: sessionId },
        application: { id: this.config.applicationId },
      }),
      trace: rawEvent.trace,
    };
  }
}
