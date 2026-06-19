import { combine } from '@datadog/browser-core';
import type { Configuration } from '../../config';
import type { SessionManager } from '../session';
import { EventKind, EventFormat, EventTrack, LifecycleKind } from '../../event';
import type {
  EventManager,
  RawProfileEvent,
  ServerProfileEvent,
  BrowserProfileEvent,
  SessionRenewEvent,
} from '../../event';
import { correctedChildSampleRate, isSessionSampled } from '../../tools/Sampler';
import { checkProfilingQuota } from './quotaCheck';

export class ProfilingCollection {
  private isCurrentSessionSampled: boolean;
  private quotaOk = true;
  private quotaCheckGeneration = 0;

  constructor(
    eventManager: EventManager,
    private readonly sessionManager: Pick<SessionManager, 'getSession'>,
    private readonly config: Configuration
  ) {
    this.isCurrentSessionSampled = this.computeProfilingSampled();
    if (this.isCurrentSessionSampled) {
      this.triggerQuotaCheck(this.sessionManager.getSession().id);
    }

    eventManager.registerHandler<RawProfileEvent>({
      canHandle: (event): event is RawProfileEvent =>
        event.kind === EventKind.RAW && event.format === EventFormat.PROFILE,
      handle: (event, notify) => {
        const server = this.enrich(event);
        if (server) notify(server);
      },
    });

    eventManager.registerHandler<SessionRenewEvent>({
      canHandle: (event): event is SessionRenewEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.SESSION_RENEW,
      handle: () => {
        this.isCurrentSessionSampled = this.computeProfilingSampled();
        this.quotaOk = true;
        if (this.isCurrentSessionSampled) {
          this.triggerQuotaCheck(this.sessionManager.getSession().id);
        }
      },
    });
  }

  private computeProfilingSampled(): boolean {
    const session = this.sessionManager.getSession();
    return isSessionSampled(
      session.id,
      correctedChildSampleRate(this.config.sessionSampleRate, this.config.profilingSampleRate)
    );
  }

  private triggerQuotaCheck(sessionId: string): void {
    const checkGeneration = ++this.quotaCheckGeneration;
    void checkProfilingQuota(this.config, sessionId).then((result) => {
      if (checkGeneration !== this.quotaCheckGeneration) {
        return;
      }
      if (result.decision === 'quota_ko') {
        this.quotaOk = false;
      }
    });
  }

  private enrich(event: RawProfileEvent): ServerProfileEvent | null {
    if (!this.isCurrentSessionSampled) return null;
    if (!this.quotaOk) return null;

    const session = this.sessionManager.getSession();
    if (session.status !== 'active') return null;

    return {
      kind: EventKind.SERVER,
      track: EventTrack.PROFILE,
      data: combine(event.data, {
        session: { id: session.id },
        application: { id: this.config.applicationId },
      }) as BrowserProfileEvent,
      trace: event.trace,
    };
  }
}
