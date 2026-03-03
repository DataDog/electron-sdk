import { describe, it, expect } from 'vitest';
import { DISCARDED, type TimeStamp } from '@datadog/browser-core';
import { createFormatHooks } from '../../assembly';
import { SessionContext } from './SessionContext';

const T0 = 0 as TimeStamp;

describe('SessionContext', () => {
  describe('before add()', () => {
    it('RUM hook returns DISCARDED', () => {
      const hooks = createFormatHooks();
      new SessionContext(hooks);

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook returns SKIPPED (undefined)', () => {
      const hooks = createFormatHooks();
      new SessionContext(hooks);

      expect(hooks.triggerTelemetry({ startTime: T0 })).toBeUndefined();
    });
  });

  describe('after add()', () => {
    it('RUM hook returns the session id', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks);

      context.add('session-abc');

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('telemetry hook returns the session id', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks);

      context.add('session-abc');

      expect(hooks.triggerTelemetry({ startTime: T0 })).toMatchObject({
        session: { id: 'session-abc' },
      });
    });

    it('reflects the latest update()', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks);

      context.add('session-first');
      context.add('session-second');

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({
        session: { id: 'session-second' },
      });
    });
  });

  describe('after close()', () => {
    it('RUM hook returns DISCARDED', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks);

      context.add('session-abc');
      context.close();

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toBe(DISCARDED);
    });

    it('telemetry hook returns SKIPPED (undefined)', () => {
      const hooks = createFormatHooks();
      const context = new SessionContext(hooks);

      context.add('session-abc');
      context.close();

      expect(hooks.triggerTelemetry({ startTime: T0 })).toBeUndefined();
    });
  });
});
