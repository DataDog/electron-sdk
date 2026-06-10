import { mockFs } from '../../mocks.specUtil';
vi.mock('node:fs/promises');
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type TimeStamp } from '@datadog/js-core/time';
import { SessionManager, SESSION_EXPIRATION_DELAY } from './SessionManager';
import { SESSION_TIME_OUT_DELAY } from './session.constants';

const T0 = 0 as TimeStamp;
import { EventManager, EventKind, LifecycleKind, type LifecycleEvent } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';

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
      sessionManager = await SessionManager.start(eventManager, hooks);

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

      sessionManager = await SessionManager.start(eventManager, hooks);

      const newSessionId = sessionManager.getSession().id;
      expect(newSessionId).not.toBe('previous-session-id');

      // Event at T_now (after relaunch) → new session
      expect(hooks.triggerRum({ eventType: 'view', startTime: now as TimeStamp })).toMatchObject({
        session: { id: newSessionId },
      });

      // Event at T0 (before relaunch, within previous session) → old session (crash attribution)
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'previous-session-id' },
      });
    });
  });

  describe('session expiration', () => {
    it('expires session after inactivity delay', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks);

      expect(sessionManager.getSession().status).toBe('active');

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      expect(sessionManager.getSession().status).toBe('expired');
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });

    it('resets inactivity timer on activity', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks);

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
      sessionManager = await SessionManager.start(eventManager, hooks);

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
      sessionManager = await SessionManager.start(eventManager, hooks);

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
      sessionManager = await SessionManager.start(eventManager, hooks);

      expect(sessionManager.getSession().status).toBe('active');

      sessionManager.expire();

      expect(sessionManager.getSession().status).toBe('expired');
      expect(lifecycleEvents).toContain(LifecycleKind.SESSION_EXPIRED);
    });
  });

  describe('hook registration', () => {
    it('RUM hook returns session id immediately after start()', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks);

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0 });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });

    it('telemetry hook returns session id immediately after start()', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks);

      const result = hooks.triggerTelemetry({ startTime: T0 });
      expect(result).toMatchObject({ session: { id: sessionManager.getSession().id } });
    });
  });

  describe('getSession', () => {
    it('should not allow to mutate the current session', async () => {
      sessionManager = await SessionManager.start(eventManager, hooks);

      const session = sessionManager.getSession();
      session.id = 'new-id';

      expect(sessionManager.getSession().id).not.toBe('new-id');
    });
  });
});
