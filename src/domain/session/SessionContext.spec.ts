import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DISCARDED, type TimeStamp } from '@datadog/browser-core';
import { createFormatHooks } from '../../assembly';
import { SessionContext } from './SessionContext';

// Fake time starts at T0 = 0 so that timeStampNow() aligns with T0
const T0 = 0 as TimeStamp;
const EXPIRE_DELAY = 1000;

describe('SessionContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('before add()', () => {
    it('RUM hook returns DISCARDED', () => {
      const hooks = createFormatHooks();
      new SessionContext(hooks, EXPIRE_DELAY);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook returns SKIPPED (undefined)', () => {
      const hooks = createFormatHooks();
      new SessionContext(hooks, EXPIRE_DELAY);

      expect(hooks.triggerTelemetry({ startTime: T0 })).toBeUndefined();
    });
  });

  describe('after add()', () => {
    it('RUM hook returns the session id', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks, EXPIRE_DELAY);

      context.add('session-abc');

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('telemetry hook returns the session id', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks, EXPIRE_DELAY);

      context.add('session-abc');

      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('reflects the latest add()', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks, EXPIRE_DELAY);

      context.add('session-first'); // at T0
      vi.advanceTimersByTime(10); // advance to T10
      context.add('session-second'); // at T10

      expect(hooks.triggerRum({ eventType: 'view', startTime: 10 as TimeStamp })).toMatchObject({
        session: { id: 'session-second' },
      });
    });
  });

  describe('after close()', () => {
    it('RUM hook still attributes events during the session period (crash attribution)', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks, EXPIRE_DELAY);

      context.add('session-abc'); // at T0 = 0
      vi.advanceTimersByTime(10); // time is now 10
      context.close(); // closed at T10

      // event at T0 (during active period) is still attributed
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('RUM hook returns DISCARDED for events before the session started', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks, EXPIRE_DELAY);

      vi.advanceTimersByTime(10); // advance to T10
      context.add('session-abc'); // session started at T10
      context.close();

      // event at T0 (before session started at T10) → DISCARDED
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook still attributes events during the session period', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks, EXPIRE_DELAY);

      context.add('session-abc'); // at T0 = 0
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });
  });
});
