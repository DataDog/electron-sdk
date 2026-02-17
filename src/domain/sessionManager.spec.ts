import { mockFs } from '../mocks.specUtil';
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

import * as display from '../tools/display';
vi.mock('../tools/display', () => ({
  displayError: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager, SESSION_EXPIRATION_DELAY, SESSION_TIME_OUT_DELAY, SESSION_FILE_NAME } from './sessionManager';
import { EventManager, EventKind, LifecycleKind, type LifecycleEvent } from '../event';
import { createFormatHooks, type FormatHooks } from '../assembly';

const mfs = mockFs();

function mockNoSessionFile() {
  mfs.access.mockRejectedValue(new Error('ENOENT'));
}

describe('sessionManager', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let sessionManager: SessionManager;
  let lifecycleEvents: string[];

  beforeEach(() => {
    vi.useFakeTimers();
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
    it('creates new session when no file exists', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks);

      expect(sessionManager.getSession().id).toMatch(/^[0-9a-f-]+$/);
      expect(sessionManager.getSession().status).toBe('active');
      expect(mfs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(SESSION_FILE_NAME),
        expect.any(String),
        'utf-8'
      );

      // no session renew event on initial session creation
      expect(lifecycleEvents).not.toContain(LifecycleKind.SESSION_RENEW);
    });

    it('resumes valid existing session', async () => {
      const now = Date.now();
      const existingState = {
        id: 'existing-session-id',
        created: now - 1000,
        lastActivity: now - 1000,
      };

      mfs.readFile.mockResolvedValue(JSON.stringify(existingState));

      sessionManager = await SessionManager.start(eventManager, hooks);

      expect(sessionManager.getSession().id).toBe('existing-session-id');
      expect(sessionManager.getSession().status).toBe('active');
    });

    it('creates new session when existing is expired (inactivity)', async () => {
      const now = Date.now();
      const existingState = {
        id: 'expired-session-id',
        created: now - SESSION_EXPIRATION_DELAY - 1000,
        lastActivity: now - SESSION_EXPIRATION_DELAY - 1000,
      };

      mfs.readFile.mockResolvedValue(JSON.stringify(existingState));

      sessionManager = await SessionManager.start(eventManager, hooks);

      expect(sessionManager.getSession().id).not.toBe('expired-session-id');
      expect(sessionManager.getSession().status).toBe('active');
    });

    it('creates new session when existing is expired (session timeout)', async () => {
      const now = Date.now();
      const existingState = {
        id: 'timed-out-session-id',
        created: now - SESSION_TIME_OUT_DELAY - 1000,
        lastActivity: now - 1000,
      };

      mfs.readFile.mockResolvedValue(JSON.stringify(existingState));

      sessionManager = await SessionManager.start(eventManager, hooks);

      expect(sessionManager.getSession().id).not.toBe('timed-out-session-id');
      expect(sessionManager.getSession().status).toBe('active');
    });
  });

  describe('session expiration', () => {
    it('expires session after inactivity delay', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks);

      expect(sessionManager.getSession().status).toBe('active');

      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      expect(sessionManager.getSession().status).toBe('expired');
      expect(mfs.unlink).toHaveBeenCalled();
    });

    it('resets inactivity timer on activity', async () => {
      const now = Date.now();
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks);

      const sessionId = sessionManager.getSession().id;

      // Advance time but not enough to expire
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY - 1000);

      // Simulate activity - need to mock readFile for the updateActivity call
      mfs.access.mockResolvedValue(undefined);
      mfs.readFile.mockResolvedValue(
        JSON.stringify({
          id: sessionId,
          created: now,
          lastActivity: now + SESSION_EXPIRATION_DELAY - 1000,
        })
      );

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
      const startTime = Date.now();
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks);

      const sessionId = sessionManager.getSession().id;
      expect(sessionId).toBeDefined();

      // Keep session alive with activity, but eventually hit session timeout
      // We need to keep refreshing activity to prevent inactivity timeout
      const activityIntervals = Math.floor(SESSION_TIME_OUT_DELAY / (SESSION_EXPIRATION_DELAY / 2));

      for (let i = 0; i < activityIntervals - 1; i++) {
        // Advance time but not enough to trigger inactivity expiration
        await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY / 2);

        if (sessionManager.getSession().status === 'active') {
          // Simulate activity to reset inactivity timer
          mfs.access.mockResolvedValue(undefined);
          mfs.readFile.mockResolvedValue(
            JSON.stringify({
              id: sessionId,
              created: startTime,
              lastActivity: Date.now(),
            })
          );
          eventManager.notify({
            kind: EventKind.LIFECYCLE,
            lifecycle: LifecycleKind.END_USER_ACTIVITY,
          });
          await vi.advanceTimersByTimeAsync(0);
        }
      }

      // Session should still be alive (we've been keeping it active)
      expect(sessionManager.getSession().status).toBe('active');

      // Advance past session timeout
      await vi.advanceTimersByTimeAsync(SESSION_EXPIRATION_DELAY);

      // Session should be expired due to session timeout
      expect(sessionManager.getSession().status).toBe('expired');
    });

    it('creates new session on activity when expired', async () => {
      mockNoSessionFile();

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

  describe('error handling', () => {
    it('handles file read errors gracefully', async () => {
      mfs.access.mockResolvedValue(undefined);
      mfs.readFile.mockRejectedValue(new Error('Read error'));

      sessionManager = await SessionManager.start(eventManager, hooks);

      // Should create a new session despite read error

      expect(sessionManager.getSession().status).toBe('active');
    });

    it('handles file write errors gracefully', async () => {
      mockNoSessionFile();
      mfs.writeFile.mockRejectedValue(new Error('Write error'));

      sessionManager = await SessionManager.start(eventManager, hooks);

      // Session should still be created in memory

      expect(sessionManager.getSession().status).toBe('active');
      expect(display.displayError).toHaveBeenCalledWith('Failed to save session state:', expect.any(Error));
    });

    it('handles JSON parse errors gracefully', async () => {
      mfs.access.mockResolvedValue(undefined);
      mfs.readFile.mockResolvedValue('invalid json');

      sessionManager = await SessionManager.start(eventManager, hooks);

      // Should create a new session despite parse error

      expect(sessionManager.getSession().status).toBe('active');
    });
  });

  describe('getSession', () => {
    it('should not allow to mutate the current session', async () => {
      mockNoSessionFile();

      sessionManager = await SessionManager.start(eventManager, hooks);

      const session = sessionManager.getSession();
      session.id = 'new-id';

      expect(sessionManager.getSession().id).not.toBe('new-id');
    });
  });
});
