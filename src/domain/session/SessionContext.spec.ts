import { mockFs } from '../../mocks.specUtil';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/user/data') },
}));

vi.mock('../../tools/display', () => ({
  displayError: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { DISCARDED } from '@datadog/browser-core';
import { createFormatHooks } from '../../assembly';
import { EventSource } from '../../event';
import { SessionContext } from './SessionContext';

vi.mock('node:fs/promises');
const mfs = mockFs();

// Fake time starts at T0 = 0 so that timeStampNow() aligns with T0
const T0 = 0 as TimeStamp;
const EXPIRE_DELAY = 1000;

describe('SessionContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  describe('before add()', () => {
    it('RUM hook returns DISCARDED', async () => {
      const hooks = createFormatHooks();
      await SessionContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('span hook returns DISCARDED', async () => {
      const hooks = createFormatHooks();
      await SessionContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('telemetry hook returns SKIPPED (undefined)', async () => {
      const hooks = createFormatHooks();
      await SessionContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN })).toBeUndefined();
    });
  });

  describe('after add()', () => {
    it('RUM hook returns the session id', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', true);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('RUM hook returns the session id for renderer source', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc');

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.RENDERER })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('span hook returns the session id', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', true);

      expect(hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN })).toMatchObject({
        meta: {
          '_dd.session.id': 'session-abc',
        },
      });
    });

    it('telemetry hook returns the session id', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', true);

      expect(hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('reflects the latest add()', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-first', true); // at T0
      vi.advanceTimersByTime(10); // advance to T10
      context.add('session-second', true); // at T10

      expect(
        hooks.triggerRum({ eventType: 'view', startTime: 10 as TimeStamp, source: EventSource.MAIN })
      ).toMatchObject({
        session: { id: 'session-second' },
      });
    });
  });

  describe('session sampling', () => {
    it('RUM hook returns DISCARDED for a non-sampled session', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', false);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('span hook is not affected by sampling (spans always pass)', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', false);

      expect(hooks.triggerSpan({ startTime: T0 })).toMatchObject({
        meta: { '_dd.session.id': 'session-abc' },
      });
    });

    it('telemetry hook is not affected by sampling (telemetry always passes)', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', false);

      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('migrates old string format from disk and treats it as sampled (crash attribution)', async () => {
      const hooks = createFormatHooks();
      // Old disk format: value was a plain session ID string (pre-sessionSampleRate)
      mfs.readFile.mockResolvedValueOnce(JSON.stringify([{ startTime: 0, endTime: 500, value: 'old-session-id' }]));
      await SessionContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'old-session-id' },
      });
    });

    it('respects isSampled from new disk format', async () => {
      const hooks = createFormatHooks();
      // New disk format: value is { id, isSampled }
      mfs.readFile.mockResolvedValueOnce(
        JSON.stringify([{ startTime: 0, endTime: 500, value: { id: 'new-session-id', isSampled: false } }])
      );
      await SessionContext.init(hooks, EXPIRE_DELAY);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });
  });

  describe('after close()', () => {
    it('RUM hook still attributes events during the session period (crash attribution)', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', true); // at T0 = 0
      vi.advanceTimersByTime(10); // time is now 10
      context.close(); // closed at T10

      // event at T0 (during active period) is still attributed
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('RUM hook returns DISCARDED for events before the session started', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      vi.advanceTimersByTime(10); // advance to T10
      context.add('session-abc', true); // session started at T10
      context.close();

      // event at T0 (before session started at T10) → DISCARDED
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('span hook still attributes events during the session period (crash attribution)', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', true); // at T0 = 0
      vi.advanceTimersByTime(10); // time is now 10
      context.close(); // closed at T10

      // event at T0 (during active period) is still attributed
      expect(hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN })).toMatchObject({
        meta: {
          '_dd.session.id': 'session-abc',
        },
      });
    });

    it('span hook returns DISCARDED for events before the session started', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      vi.advanceTimersByTime(10); // advance to T10
      context.add('session-abc', true); // session started at T10
      context.close();

      // event at T0 (before session started at T10) → DISCARDED
      expect(hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN })).toBe(DISCARDED);
    });

    it('telemetry hook still attributes events during the session period', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', true); // at T0 = 0
      vi.advanceTimersByTime(10);
      context.close();

      expect(hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('RUM hook returns DISCARDED for events after the session ended', async () => {
      const hooks = createFormatHooks();
      const context = await SessionContext.init(hooks, EXPIRE_DELAY);

      context.add('session-abc', true); // at T0
      vi.advanceTimersByTime(10); // now T10
      context.close(); // closed at T10

      // Event at T20 (after session ended at T10) → DISCARDED
      expect(hooks.triggerRum({ eventType: 'view', startTime: 20 as TimeStamp, source: EventSource.MAIN })).toBe(
        DISCARDED
      );
    });
  });
});
