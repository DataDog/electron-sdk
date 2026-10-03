import { mockFs } from '../../mocks.specUtil';
vi.mock('node:fs/promises');
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

import { DISCARDED } from '@datadog/js-core/assembly';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import type { Configuration } from '../../config';
import { EventKind, EventManager, EventSource, LifecycleKind, type LifecycleEvent } from '../../event';
import * as Sampler from '../../tools/Sampler';
import { SESSION_EXPIRATION_DELAY, SessionManager } from './SessionManager';
import { SESSION_TIME_OUT_DELAY } from './session.constants';
import { isCurrentSessionSampled } from '../../common';
import { ContextHistoryFactory, TrackingConsentManager } from '../tracking-consent';

const T0 = 0 as TimeStamp;

const makeConfig = (overrides: Partial<Configuration> = {}): Configuration =>
  ({ sessionSampleRate: 100, ...overrides }) as Configuration;

const mfs = mockFs();

describe('sessionManager', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let sessionManager: SessionManager;
  let trackingConsentManager: TrackingConsentManager;
  let histories: ContextHistoryFactory;
  let lifecycleEvents: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    trackingConsentManager = new TrackingConsentManager();
    histories = new ContextHistoryFactory(trackingConsentManager, '/mock/user/data');
    mfs.writeFile.mockResolvedValue(undefined);
    eventManager = new EventManager();
    lifecycleEvents = [];
    eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => lifecycleEvents.push(event.lifecycle),
    });
    hooks = createFormatHooks();
  });

  afterEach(() => {
    histories.stop();
    sessionManager.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  describe('session creation', () => {
    it('creates new session on start', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      expect(sessionManager.getSession().id).toMatch(/^[0-9a-f-]+$/);
      expect(sessionManager.getSession().status).toBe('active');

      // no session renew event on initial session creation
      expect(lifecycleEvents).not.toContain(LifecycleKind.SESSION_RENEW);
    });

    it('closes previous session history entry on new launch', async () => {
      vi.setSystemTime(1000);
      histories.stop();
      histories = new ContextHistoryFactory(trackingConsentManager, '/mock/user/data');
      const now = Date.now();
      mfs.readFile.mockResolvedValueOnce(
        JSON.stringify([{ startTime: 0, endTime: null, value: 'previous-session-id' }])
      ); // _dd_session_history

      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      const newSessionId = sessionManager.getSession().id;
      expect(newSessionId).not.toBe('previous-session-id');

      // Event at T_now (after relaunch) → new session
      expect(
        hooks.triggerRum({ eventType: 'view', startTime: now as TimeStamp, source: EventSource.MAIN })
      ).toMatchObject({
        session: { id: newSessionId },
      });

      // Event at T0 (before relaunch, within previous session) → old session (crash attribution)
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toMatchObject({
        session: { id: 'previous-session-id' },
      });
    });
  });

  describe('session expiration', () => {
    it('expires session after inactivity delay', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      expect(sessionManager.getSession().status).toBe('active');

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      expect(sessionManager.getSession().status).toBe('expired');
      expect(isCurrentSessionSampled()).toBe(false);
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });

    it('resets inactivity timer on activity', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      const sessionId = sessionManager.getSession().id;

      // Advance time but not enough to expire
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY - 1000);

      eventManager.notify({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.END_USER_ACTIVITY,
      });
      await vi.advanceTimersByTimeAsync(0);

      // Advance time again - should not expire yet because timer was reset
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY - 1000);

      expect(sessionManager.getSession().status).toBe('active');
      expect(sessionManager.getSession().id).toBe(sessionId);
    });

    it('expires session after session timeout regardless of activity', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      const sessionId = sessionManager.getSession().id;
      expect(sessionId).toBeDefined();

      // Keep session alive with activity, but eventually hit session timeout
      const activityIntervals = Math.floor(SESSION_TIME_OUT_DELAY / (SESSION_EXPIRATION_DELAY / 2));

      for (let i = 0; i < activityIntervals - 1; i++) {
        await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY / 2);

        if (sessionManager.getSession().status === 'active') {
          eventManager.notify({
            kind: EventKind.LIFECYCLE,
            lifecycle: LifecycleKind.END_USER_ACTIVITY,
          });
          await vi.advanceTimersByTimeAsync(0);
        }
      }

      expect(sessionManager.getSession().status).toBe('active');

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      expect(sessionManager.getSession().status).toBe('expired');
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });

    it('creates new session on activity when expired', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      const originalSessionId = sessionManager.getSession().id;
      expect(sessionManager.getSession().status).toBe('active');

      // Let session expire
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);
      expect(sessionManager.getSession().status).toBe('expired');
      expect(sessionManager.getSession().id).toBe(originalSessionId);

      // Trigger activity on expired session
      eventManager.notify({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.END_USER_ACTIVITY,
      });
      await vi.advanceTimersByTimeAsync(0);

      // Should have a new session with active status
      expect(sessionManager.getSession().status).toBe('active');
      expect(sessionManager.getSession().id).not.toBe(originalSessionId);

      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_RENEW);
    });
  });

  describe('expire', () => {
    it('sets session status to expired and clears timers', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      expect(sessionManager.getSession().status).toBe('active');

      sessionManager.expire();

      expect(sessionManager.getSession().status).toBe('expired');
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });

    it('emits the expiration event only once', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      sessionManager.expire();
      sessionManager.expire();

      expect(lifecycleEvents.filter((event) => event === LifecycleKind.SESSION_EXPIRED)).toHaveLength(1);
    });
  });

  describe('hook registration', () => {
    it('RUM hook returns session id immediately after start()', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });

    it('telemetry hook returns session id immediately after start()', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      const result = hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });
  });

  describe('getSession', () => {
    it('should not allow to mutate the current session', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      const session = sessionManager.getSession();
      session.id = 'new-id';

      expect(sessionManager.getSession().id).not.toBe('new-id');
    });
  });

  describe('tracking consent', () => {
    it('starts denied without a tracked session or timers and ignores activity', async () => {
      trackingConsentManager.update('not-granted');
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);
      const initialSession = sessionManager.getSession();

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });

      expect(initialSession.status).toBe('expired');
      expect(sessionManager.getSession()).toEqual(initialSession);
      expect(sessionManager.getTrackedSessionId()).toBeUndefined();
      expect(isCurrentSessionSampled()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(lifecycleEvents).not.toContain(LifecycleKind.SESSION_RENEW);
    });

    it('starts an active tracked session while pending', async () => {
      trackingConsentManager.update('pending');
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      expect(sessionManager.getSession().status).toBe('active');
      expect(sessionManager.getTrackedSessionId()).toBe(sessionManager.getSession().id);
      expect(isCurrentSessionSampled()).toBe(true);

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      expect(sessionManager.getSession().status).toBe('expired');
    });

    it('preserves an active session and its inactivity deadline between granted and pending', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);
      const initialSession = sessionManager.getSession();

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY - 10);
      trackingConsentManager.update('pending');
      trackingConsentManager.update('granted');

      expect(sessionManager.getSession()).toEqual(initialSession);
      expect(lifecycleEvents).not.toContain(LifecycleKind.SESSION_RENEW);

      await vi.advanceTimersByTimeAsync(10);

      expect(sessionManager.getSession().status).toBe('expired');
    });

    it.each(['granted', 'pending'] as const)(
      'expires on refusal and creates a fresh session when %s resumes',
      async (consent) => {
        sessionManager = await SessionManager.start(
          eventManager,
          hooks,
          makeConfig(),
          histories,
          trackingConsentManager
        );
        const firstId = sessionManager.getSession().id;
        vi.advanceTimersByTime(10);

        trackingConsentManager.update('not-granted');
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });

        expect(sessionManager.getSession()).toEqual({ id: firstId, status: 'expired' });
        expect(sessionManager.getTrackedSessionId()).toBeUndefined();
        expect(sessionManager.getTrackedSessionId(T0)).toBe(firstId);
        expect(isCurrentSessionSampled()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);

        vi.advanceTimersByTime(10);
        trackingConsentManager.update(consent);
        trackingConsentManager.update(consent);

        expect(sessionManager.getSession().status).toBe('active');
        expect(sessionManager.getSession().id).not.toBe(firstId);
        expect(sessionManager.getTrackedSessionId()).toBe(sessionManager.getSession().id);
        expect(sessionManager.getTrackedSessionId(15 as TimeStamp)).toBeUndefined();
        expect(lifecycleEvents.filter((event) => event === LifecycleKind.SESSION_RENEW)).toHaveLength(1);
      }
    );

    it.each(['granted', 'pending'] as const)(
      'renews an expired %s session once when the other enabled state is selected',
      async (initialConsent) => {
        trackingConsentManager.update(initialConsent);
        sessionManager = await SessionManager.start(
          eventManager,
          hooks,
          makeConfig(),
          histories,
          trackingConsentManager
        );
        const firstId = sessionManager.getSession().id;
        sessionManager.expire();

        trackingConsentManager.update(initialConsent === 'granted' ? 'pending' : 'granted');
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });

        expect(sessionManager.getSession().status).toBe('active');
        expect(sessionManager.getSession().id).not.toBe(firstId);
        expect(sessionManager.getTrackedSessionId()).toBe(sessionManager.getSession().id);
        expect(lifecycleEvents.filter((event) => event === LifecycleKind.SESSION_RENEW)).toHaveLength(1);
      }
    );

    it('does not restore a rejected pending session when refusal and grant share a timestamp', async () => {
      trackingConsentManager.update('pending');
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);
      const rejectedId = sessionManager.getSession().id;
      vi.advanceTimersByTime(10);

      trackingConsentManager.update('not-granted');
      trackingConsentManager.update('granted');

      expect(sessionManager.getSession().id).not.toBe(rejectedId);
      expect(sessionManager.getTrackedSessionId(T0)).toBeUndefined();
      expect(sessionManager.getTrackedSessionId()).toBe(sessionManager.getSession().id);
      expect(lifecycleEvents).toEqual([LifecycleKind.SESSION_EXPIRED, LifecycleKind.SESSION_RENEW]);
    });

    it('uses consent transition timestamps even when earlier observers take time', async () => {
      const subscription = trackingConsentManager.subscribe(() => vi.setSystemTime(Date.now() + 5));
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);
      const notify = vi.spyOn(eventManager, 'notify');

      vi.setSystemTime(100);
      trackingConsentManager.update('not-granted');
      vi.setSystemTime(200);
      trackingConsentManager.update('granted');

      expect(sessionManager.getTrackedSessionId(100 as TimeStamp)).toBeUndefined();
      expect(sessionManager.getTrackedSessionId(200 as TimeStamp)).toBe(sessionManager.getSession().id);
      expect(notify).toHaveBeenCalledWith({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.SESSION_EXPIRED,
        time: 100,
      });
      expect(notify).toHaveBeenCalledWith({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.SESSION_RENEW,
        time: 200,
      });
      subscription.unsubscribe();
    });

    it('releases its consent and activity subscriptions on stop', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);
      trackingConsentManager.update('not-granted');
      const expiredSession = sessionManager.getSession();
      lifecycleEvents.length = 0;
      sessionManager.stop();

      trackingConsentManager.update('granted');
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });

      expect(sessionManager.getSession()).toEqual(expiredSession);
      expect(vi.getTimerCount()).toBe(0);
      expect(lifecycleEvents).not.toContain(LifecycleKind.SESSION_RENEW);
    });
  });

  describe('sessionSampleRate', () => {
    it('session is sampled when sampleRate is 100', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      expect(isCurrentSessionSampled()).toBe(true);
      // A sampled session is tracked, so getInternalContext()/correlation can resolve its id.
      expect(sessionManager.getTrackedSessionId()).toBe(sessionManager.getSession().id);
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).not.toBe(DISCARDED);
    });

    it('session is not sampled when sampleRate is 0', async () => {
      sessionManager = await SessionManager.start(
        eventManager,
        hooks,
        makeConfig({ sessionSampleRate: 0 }),
        histories,
        trackingConsentManager
      );

      expect(isCurrentSessionSampled()).toBe(false);
      // A non-sampled session is not tracked, so getInternalContext() resolves to undefined —
      // no session id leaks for a session that produces no RUM.
      expect(sessionManager.getTrackedSessionId()).toBeUndefined();
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('getTrackedSessionId returns undefined once the session has expired', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);
      expect(sessionManager.getTrackedSessionId()).toBeDefined();

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);
      expect(sessionManager.getSession().status).toBe('expired');

      expect(sessionManager.getTrackedSessionId()).toBeUndefined();
    });

    it('RUM hook returns session id when session is sampled', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });

    it('RUM hook returns DISCARDED when session is not sampled', async () => {
      sessionManager = await SessionManager.start(
        eventManager,
        hooks,
        makeConfig({ sessionSampleRate: 0 }),
        histories,
        trackingConsentManager
      );

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
      expect(result).toBe(DISCARDED);
    });

    it('renewed session gets its own sampling decision', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig(), histories, trackingConsentManager);

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
      await vi.advanceTimersByTimeAsync(0);

      // new session with sampleRate=100 must also be sampled
      expect(hooks.triggerRum({ eventType: 'view', startTime: timeStampNow(), source: EventSource.MAIN })).not.toBe(
        DISCARDED
      );
    });

    it('attributes events correctly across renews with mixed sampling outcomes', async () => {
      // First session sampled, second not sampled, third sampled.
      const sampledSpy = vi
        .spyOn(Sampler, 'isSessionSampled')
        .mockReturnValueOnce(true) // session #1
        .mockReturnValueOnce(false) // session #2
        .mockReturnValueOnce(true); // session #3

      const DURING_FIRST = T0;
      const DURING_SECOND = (SESSION_EXPIRATION_DELAY + 1) as TimeStamp;
      const DURING_THIRD = (2 * SESSION_EXPIRATION_DELAY + 1) as TimeStamp;

      const renewActivity = async () => {
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        await vi.advanceTimersByTimeAsync(0);
      };
      const renewCount = () => lifecycleEvents.filter((e) => e === LifecycleKind.SESSION_RENEW).length;

      // --- Session #1 (sampled): RUM hook returns its id until expiration ---
      sessionManager = await SessionManager.start(
        eventManager,
        hooks,
        makeConfig({ sessionSampleRate: 50 }),
        histories,
        trackingConsentManager
      );
      const firstId = sessionManager.getSession().id;
      expect(hooks.triggerRum({ eventType: 'view', startTime: DURING_FIRST, source: EventSource.MAIN })).toMatchObject({
        session: { id: firstId },
      });

      // --- Expire #1 and renew → Session #2 (not sampled) ---
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);
      await renewActivity();
      const secondId = sessionManager.getSession().id;
      expect(secondId).not.toBe(firstId);
      expect(hooks.triggerRum({ eventType: 'view', startTime: DURING_SECOND, source: EventSource.MAIN })).toBe(
        DISCARDED
      );

      // Activity while the non-sampled session is still active does NOT create a new session
      const renewsBefore = renewCount();
      await renewActivity();
      expect(sessionManager.getSession().id).toBe(secondId);
      expect(renewCount()).toBe(renewsBefore);
      expect(hooks.triggerRum({ eventType: 'view', startTime: DURING_SECOND, source: EventSource.MAIN })).toBe(
        DISCARDED
      );

      // --- Expire #2 and renew → Session #3 (sampled): attribution resumes ---
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);
      await renewActivity();
      const thirdId = sessionManager.getSession().id;
      expect(thirdId).not.toBe(secondId);
      expect(hooks.triggerRum({ eventType: 'view', startTime: DURING_THIRD, source: EventSource.MAIN })).toMatchObject({
        session: { id: thirdId },
      });

      // Earlier sessions remain correctly attributed for crash/late events
      expect(hooks.triggerRum({ eventType: 'view', startTime: DURING_FIRST, source: EventSource.MAIN })).toMatchObject({
        session: { id: firstId },
      });
      expect(hooks.triggerRum({ eventType: 'view', startTime: DURING_SECOND, source: EventSource.MAIN })).toBe(
        DISCARDED
      );

      expect(sampledSpy).toHaveBeenCalledTimes(3);
      sampledSpy.mockRestore();
    });
  });
});
