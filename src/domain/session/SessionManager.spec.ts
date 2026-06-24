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

const T0 = 0 as TimeStamp;

const makeConfig = (overrides: Partial<Configuration> = {}): Configuration =>
  ({ sessionSampleRate: 100, ...overrides }) as Configuration;

const mfs = mockFs();

describe('sessionManager', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let sessionManager: SessionManager;
  let lifecycleEvents: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
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
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
    sessionManager.stop();
  });

  describe('session creation', () => {
    it('creates new session on start', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

      expect(sessionManager.getSession().id).toMatch(/^[0-9a-f-]+$/);
      expect(sessionManager.getSession().status).toBe('active');

      // no session renew event on initial session creation
      expect(lifecycleEvents).not.toContain(LifecycleKind.SESSION_RENEW);
    });

    it('closes previous session history entry on new launch', async () => {
      vi.setSystemTime(1000);
      const now = Date.now();
      mfs.readFile.mockResolvedValueOnce(
        JSON.stringify([{ startTime: 0, endTime: null, value: 'previous-session-id' }])
      ); // _dd_session_history

      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

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
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

      expect(sessionManager.getSession().status).toBe('active');

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      expect(sessionManager.getSession().status).toBe('expired');
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });

    it('resets inactivity timer on activity', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

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
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

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
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

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
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

      expect(sessionManager.getSession().status).toBe('active');

      sessionManager.expire();

      expect(sessionManager.getSession().status).toBe('expired');
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });
  });

  describe('hook registration', () => {
    it('RUM hook returns session id immediately after start()', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });

    it('telemetry hook returns session id immediately after start()', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

      const result = hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });
  });

  describe('getSession', () => {
    it('should not allow to mutate the current session', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

      const session = sessionManager.getSession();
      session.id = 'new-id';

      expect(sessionManager.getSession().id).not.toBe('new-id');
    });
  });

  describe('sessionSampleRate', () => {
    it('session is sampled when sampleRate is 100', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

      // A sampled session is tracked, so getInternalContext()/correlation can resolve its id.
      expect(sessionManager.getTrackedSessionId()).toBe(sessionManager.getSession().id);
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).not.toBe(DISCARDED);
    });

    it('session is not sampled when sampleRate is 0', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig({ sessionSampleRate: 0 }));

      // A non-sampled session is not tracked, so getInternalContext() resolves to undefined —
      // no session id leaks for a session that produces no RUM.
      expect(sessionManager.getTrackedSessionId()).toBeUndefined();
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('getTrackedSessionId returns undefined once the session has expired', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());
      expect(sessionManager.getTrackedSessionId()).toBeDefined();

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);
      expect(sessionManager.getSession().status).toBe('expired');

      // The history entry is closed at the expiry timestamp and find() is inclusive of endTime,
      // so the session stops being tracked once time moves past the close — matching how the
      // RUM/span/telemetry hooks attribute boundary events (single source of truth).
      await vi.advanceTimersByTimeAsync(1);
      expect(sessionManager.getTrackedSessionId()).toBeUndefined();
    });

    it('RUM hook returns session id when session is sampled', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });

    it('RUM hook returns DISCARDED when session is not sampled', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig({ sessionSampleRate: 0 }));

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
      expect(result).toBe(DISCARDED);
    });

    it('renewed session gets its own sampling decision', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig());

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

      // Events fall strictly inside each session's window (find() treats endTime as inclusive).
      const DURING_FIRST = T0; // session #1: [0, EXPIRATION]
      const DURING_SECOND = (SESSION_EXPIRATION_DELAY + 1) as TimeStamp; // session #2: (EXPIRATION, 2*EXPIRATION]
      const DURING_THIRD = (2 * SESSION_EXPIRATION_DELAY + 1) as TimeStamp; // session #3: (2*EXPIRATION, ...]

      const renewActivity = async () => {
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        await vi.advanceTimersByTimeAsync(0);
      };
      const renewCount = () => lifecycleEvents.filter((e) => e === LifecycleKind.SESSION_RENEW).length;

      // --- Session #1 (sampled): RUM hook returns its id until expiration ---
      sessionManager = await SessionManager.start(eventManager, hooks, makeConfig({ sessionSampleRate: 50 }));
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
