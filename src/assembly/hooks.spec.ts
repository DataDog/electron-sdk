import { describe, it, expect } from 'vitest';
import { DISCARDED, SKIPPED } from '@datadog/browser-core';
import { createFormatHooks } from './hooks';

describe('createFormatHooks', () => {
  describe('triggerRum', () => {
    it('returns undefined when no callbacks are registered', () => {
      const hooks = createFormatHooks();
      const result = hooks.triggerRum({ eventType: 'view', startTime: 0 });
      expect(result).toBeUndefined();
    });

    it('returns the result of a single callback', () => {
      const hooks = createFormatHooks();
      hooks.registerRum(() => ({ session: { id: 'session-1' } }));

      const result = hooks.triggerRum({ eventType: 'view', startTime: 100 });
      expect(result).toEqual({ session: { id: 'session-1' } });
    });

    it('combines results from multiple callbacks', () => {
      const hooks = createFormatHooks();
      hooks.registerRum(() => ({ session: { id: 'session-1' } }));
      hooks.registerRum(() => ({ date: 123, source: 'electron' }));

      const result = hooks.triggerRum({ eventType: 'view', startTime: 0 });
      expect(result).toEqual({ session: { id: 'session-1' }, date: 123, source: 'electron' });
    });

    it('deep merges results from multiple callbacks', () => {
      const hooks = createFormatHooks();
      hooks.registerRum(() => ({ _dd: { format_version: 2 } }));
      hooks.registerRum(() => ({ _dd: { document_version: 1 } }));

      const result = hooks.triggerRum({ eventType: 'view', startTime: 0 });
      expect(result).toEqual({ _dd: { format_version: 2, document_version: 1 } });
    });

    it('passes params to callbacks', () => {
      const hooks = createFormatHooks();
      hooks.registerRum((params) => ({ date: params.startTime }));

      const result = hooks.triggerRum({ eventType: 'view', startTime: 42 });
      expect(result).toEqual({ date: 42 });
    });

    it('returns DISCARDED when a callback returns DISCARDED', () => {
      const hooks = createFormatHooks();
      hooks.registerRum(() => ({ session: { id: 'session-1' } }));
      hooks.registerRum(() => DISCARDED);

      const result = hooks.triggerRum({ eventType: 'view', startTime: 0 });
      expect(result).toBe(DISCARDED);
    });

    it('skips callbacks that return SKIPPED', () => {
      const hooks = createFormatHooks();
      hooks.registerRum(() => SKIPPED);
      hooks.registerRum(() => ({ session: { id: 'session-1' } }));

      const result = hooks.triggerRum({ eventType: 'view', startTime: 0 });
      expect(result).toEqual({ session: { id: 'session-1' } });
    });

    it('supports unregistering a callback', () => {
      const hooks = createFormatHooks();
      const { unregister } = hooks.registerRum(() => ({ date: 999 }));
      hooks.registerRum(() => ({ session: { id: 'session-1' } }));

      unregister();

      const result = hooks.triggerRum({ eventType: 'view', startTime: 0 });
      expect(result).toEqual({ session: { id: 'session-1' } });
    });
  });

  describe('triggerTelemetry', () => {
    it('returns undefined when no callbacks are registered', () => {
      const hooks = createFormatHooks();
      const result = hooks.triggerTelemetry({ startTime: 0 });
      expect(result).toBeUndefined();
    });

    it('combines results from multiple callbacks', () => {
      const hooks = createFormatHooks();
      hooks.registerTelemetry(() => ({ session: { id: 'session-1' } }));
      hooks.registerTelemetry(() => ({ date: 123, source: 'electron' }));

      const result = hooks.triggerTelemetry({ startTime: 0 });
      expect(result).toEqual({ session: { id: 'session-1' }, date: 123, source: 'electron' });
    });
  });

  describe('format isolation', () => {
    it('does not mix RUM and telemetry callbacks', () => {
      const hooks = createFormatHooks();
      hooks.registerRum(() => ({ date: 111 }));
      hooks.registerTelemetry(() => ({ date: 222 }));

      expect(hooks.triggerRum({ eventType: 'view', startTime: 0 })).toEqual({ date: 111 });
      expect(hooks.triggerTelemetry({ startTime: 0 })).toEqual({ date: 222 });
    });
  });
});
