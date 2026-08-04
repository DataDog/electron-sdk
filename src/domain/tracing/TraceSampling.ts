import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import type { Configuration } from '../../config';
import type { FormatHooks } from '../../assembly';
import { setTraceSampled } from '../../common';
import type { EventManager, LifecycleEvent } from '../../event';
import { EventKind, LifecycleKind } from '../../event';
import { correctedChildSampleRate, isSessionSampled } from '../../tools/Sampler';
import type { SessionManager } from '../session';

/**
 * Keeps trace sampling aligned with the RUM session and blocks exported spans that do not belong to
 * a trace-sampled session. Instrumentation reads the shared current decision before creating IPC spans
 * or injecting HTTP headers; the span hook is the authoritative safety net for delayed exports. Local
 * HTTP spans remain enabled because they are converted into RUM resources.
 */
export class TraceSampling {
  constructor(
    eventManager: EventManager,
    private readonly sessionManager: Pick<SessionManager, 'getSession' | 'getTrackedSessionId'>,
    private readonly config: Configuration,
    hooks: FormatHooks
  ) {
    this.updateCurrentDecision();

    hooks.registerSpan(({ startTime }) => {
      const sessionId = this.sessionManager.getTrackedSessionId(startTime);
      return sessionId !== undefined && this.isSampled(sessionId) ? SKIPPED : DISCARDED;
    });

    eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => {
        if (event.lifecycle === LifecycleKind.SESSION_EXPIRED) {
          setTraceSampled(false);
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          this.updateCurrentDecision();
        }
      },
    });
  }

  private updateCurrentDecision(): void {
    const session = this.sessionManager.getSession();
    setTraceSampled(session.status === 'active' && this.isSampled(session.id));
  }

  private isSampled(sessionId: string): boolean {
    return isSessionSampled(
      sessionId,
      correctedChildSampleRate(this.config.sessionSampleRate, this.config.traceSampleRate)
    );
  }
}
