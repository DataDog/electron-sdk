import { combine } from '@datadog/js-core/util';
import { SKIPPED } from '@datadog/js-core/assembly';
import type { TimeStamp } from '@datadog/js-core/time';
import type { Configuration } from '../../config';
import type { FormatHooks, RumEventType } from '../../assembly';
import type { SessionManager } from '../session';
import type { EventManager, RawProfileEvent, ServerProfileEvent, SessionRenewEvent } from '../../event';
import { EventFormat, EventKind, EventSource, EventTrack, LifecycleKind } from '../../event';
import { correctedChildSampleRate, isSessionSampled } from '../../tools/Sampler';
import { monitor } from '../telemetry';
import type { QuotaReason, QuotaResult } from './quotaCheck';
import { checkProfilingQuota } from './quotaCheck';

// The browser SDK attaches its profiling context only to these event types (see the browser SDK's
// profilingContext assemble hook), so electron scopes its contribution the same way to stay consistent.
const PROFILING_EVENT_TYPES: readonly RumEventType[] = ['view', 'long_task', 'action', 'vital'];

export class ProfilingCollection {
  // Sessions denied by the backend quota, keyed by session id (value is the denial reason). A profile is
  // gated on the quota decision of the session that captured it, not the current one, so a profile flushed
  // after a renewal is still dropped if its own session was denied. Absence means "not denied" (allowed or
  // still pending the async check, i.e. optimistic).
  private readonly quotaDeniedSessions = new Map<string, QuotaReason>();

  constructor(
    eventManager: EventManager,
    private readonly sessionManager: Pick<SessionManager, 'getSession' | 'getTrackedSessionId'>,
    private readonly config: Configuration,
    hooks: FormatHooks
  ) {
    this.maybeCheckQuota();

    // Enrich renderer RUM events with the profiling context electron is authoritative for. The renderer
    // (browser SDK) owns `status`/`error_reason`; electron contributes `quota_reason` (forcing `stopped` on
    // quota_ko, mirroring the browser SDK) and suppresses the context for sessions it sampled out. See the
    // Profiling / Error Reporting notes in docs/ARCHITECTURE.md.
    hooks.registerRum(({ source, eventType, startTime }) => {
      if (source !== EventSource.RENDERER || !PROFILING_EVENT_TYPES.includes(eventType as RumEventType)) {
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
      const quotaDeniedReason = this.quotaDeniedSessions.get(sessionId);
      if (quotaDeniedReason !== undefined) {
        return {
          _dd: { profiling: { status: 'stopped', quota_reason: quotaDeniedReason } },
        };
      }
      // Sampled in and allowed: keep the renderer's own `_dd.profiling`.
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

    eventManager.registerHandler<SessionRenewEvent>({
      canHandle: (event): event is SessionRenewEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.SESSION_RENEW,
      handle: () => {
        this.maybeCheckQuota();
      },
    });
  }

  // Trigger a quota check for the current session, but only when it is profiling-sampled (an unsampled
  // session never produces profiles, so its quota is irrelevant).
  private maybeCheckQuota(): void {
    const session = this.sessionManager.getSession();
    if (this.isProfilingSampled(session.id)) {
      this.triggerQuotaCheck(session.id);
    }
  }

  private isProfilingSampled(sessionId: string): boolean {
    return isSessionSampled(
      sessionId,
      correctedChildSampleRate(this.config.sessionSampleRate, this.config.profilingSampleRate)
    );
  }

  private triggerQuotaCheck(sessionId: string): void {
    void checkProfilingQuota(this.config, sessionId).then(
      monitor((result: QuotaResult) => {
        if (result.decision === 'quota_ko') {
          // Record the denial against the session it was checked for, so profiles are gated on their own
          // session's decision.
          this.quotaDeniedSessions.set(sessionId, result.reason);
        }
      })
    );
  }

  private processProfile(rawEvent: RawProfileEvent): ServerProfileEvent | null {
    // Attribute the profile to the session that produced it, not the current one: a profile can be flushed
    // asynchronously (e.g. on unload) after the session renewed or expired. Resolve the session covering the
    // profile's start time from the session history (like RUM events do via their start time), and drop the
    // profile if none covered it (window expired, or the session was not sampled). Sampling and the quota
    // decision are then evaluated for that session so they match the one that captured the profile.
    const captureTime = new Date(rawEvent.data.start).getTime() as TimeStamp;
    const sessionId = this.sessionManager.getTrackedSessionId(captureTime);
    if (sessionId === undefined || !this.isProfilingSampled(sessionId)) {
      return null;
    }
    if (this.quotaDeniedSessions.has(sessionId)) {
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
