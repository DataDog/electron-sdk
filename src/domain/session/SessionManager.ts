import { ONE_MINUTE } from '@datadog/js-core/time';
import { deepClone, generateUUID, type Subscription } from '@datadog/browser-core';
import { type EndUserActivityEvent, EventKind, EventManager, LifecycleKind } from '../../event';
import type { FormatHooks } from '../../assembly';
import type { Configuration } from '../../config';
import { setTimeout } from '../telemetry';
import { SessionContext } from './SessionContext';
import { SESSION_TIME_OUT_DELAY } from './session.constants';
import { isSessionSampled } from '../../tools/Sampler';

export const SESSION_EXPIRATION_DELAY = 15 * ONE_MINUTE;

export interface Session {
  id: string;
  status: SessionStatus;
}

export type SessionStatus = 'active' | 'expired';

/**
 * Track session lifecycle
 * - on start, always create a new Session
 * - after SESSION_EXPIRATION_DELAY without activity, expire the Session
 * - after SESSION_TIME_OUT_DELAY if the Session is still active, expire the Session
 * - on activity, if the Session is expired, create a new Session
 */
export class SessionManager {
  private currentSession!: Session;
  private sessionContext!: SessionContext;
  private inactivityTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private sessionTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private activitySubscription: Subscription | undefined;

  private constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks,
    private readonly configuration: Configuration
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    configuration: Configuration
  ): Promise<SessionManager> {
    const manager = new SessionManager(eventManager, hooks, configuration);
    await manager.init();
    return manager;
  }

  getSession(): Session {
    return deepClone(this.currentSession);
  }

  expire(): void {
    this.expireSession();
  }

  stop(): void {
    this.clearTimers();
    if (this.activitySubscription) {
      this.activitySubscription.unsubscribe();
      this.activitySubscription = undefined;
    }
  }

  private async init(): Promise<void> {
    this.sessionContext = await SessionContext.init(this.hooks);
    this.sessionContext.close();
    this.createNewSession();

    this.activitySubscription = this.eventManager.registerHandler<EndUserActivityEvent>({
      canHandle: (event): event is EndUserActivityEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.END_USER_ACTIVITY,
      handle: () => {
        this.updateActivity();
      },
    });
  }

  private createNewSession(): void {
    const now = Date.now();
    const id = generateUUID();
    const isSampled = isSessionSampled(id, this.configuration.sessionSampleRate);

    this.currentSession = { id, status: 'active' };
    if (isSampled) {
      this.sessionContext.add(id);
    }

    this.scheduleInactivityTimeout();
    this.scheduleSessionTimeout(now);
  }

  private expireSession(): void {
    this.clearTimers();
    this.currentSession.status = 'expired';
    this.sessionContext.close();
    this.eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
  }

  private updateActivity(): void {
    if (this.currentSession.status === 'expired') {
      this.createNewSession();
      this.eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      return;
    }

    this.scheduleInactivityTimeout();
  }

  private scheduleInactivityTimeout(): void {
    if (this.inactivityTimeoutId !== undefined) {
      clearTimeout(this.inactivityTimeoutId);
    }
    this.inactivityTimeoutId = setTimeout(() => this.expireSession(), SESSION_EXPIRATION_DELAY);
  }

  private scheduleSessionTimeout(createdAt: number): void {
    const now = Date.now();
    const remainingTime = SESSION_TIME_OUT_DELAY - (now - createdAt);
    if (remainingTime > 0) {
      this.sessionTimeoutId = setTimeout(() => this.expireSession(), remainingTime);
    } else {
      this.expireSession();
    }
  }

  private clearTimers(): void {
    if (this.inactivityTimeoutId !== undefined) {
      clearTimeout(this.inactivityTimeoutId);
      this.inactivityTimeoutId = undefined;
    }
    if (this.sessionTimeoutId !== undefined) {
      clearTimeout(this.sessionTimeoutId);
      this.sessionTimeoutId = undefined;
    }
  }
}
