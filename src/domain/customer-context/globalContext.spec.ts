import { beforeEach, describe, it, expect, vi } from 'vitest';
import { type TimeStamp } from '@datadog/js-core/time';
import { EventSource } from '../../event';
import { createFormatHooks, type FormatHooks, type RumEventType } from '../../assembly';
import { GlobalContext } from './globalContext';
import type { ContextHistory } from './contextManager';

const T0 = 0 as TimeStamp;

describe('GlobalContext', () => {
  let hooks: FormatHooks;
  let globalContext: GlobalContext;

  function triggerRum(eventType: RumEventType = 'view') {
    return hooks.triggerRum({ eventType, startTime: T0, source: EventSource.MAIN });
  }

  beforeEach(() => {
    hooks = createFormatHooks();
    globalContext = new GlobalContext(hooks);
  });

  describe('when no context is set', () => {
    it('contributes nothing', () => {
      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });
  });

  describe('setContext', () => {
    it('injects the attributes as context on RUM events', () => {
      globalContext.setContext({ team: 'checkout', build: '1.2.3' });

      expect(triggerRum()).toEqual({ context: { team: 'checkout', build: '1.2.3' } });
    });

    it('replaces the whole context rather than merging', () => {
      globalContext.setContext({ team: 'checkout' });
      globalContext.setContext({ build: '1.2.3' });

      expect(triggerRum()).toEqual({ context: { build: '1.2.3' } });
    });

    it('keeps a customer attribute named extraInfo instead of unwrapping it', () => {
      globalContext.setContext({ team: 'checkout', extraInfo: { plan: 'premium' } });

      expect(triggerRum()).toEqual({ context: { team: 'checkout', extraInfo: { plan: 'premium' } } });
    });

    it('does not mutate the caller object', () => {
      const context = { team: 'checkout' };
      globalContext.setContext(context);
      globalContext.setProperty('build', '1.2.3');

      expect(context).toEqual({ team: 'checkout' });
    });
  });

  describe('setProperty', () => {
    it('adds a property without touching the others', () => {
      globalContext.setContext({ team: 'checkout' });
      globalContext.setProperty('build', '1.2.3');

      expect(triggerRum()).toEqual({ context: { team: 'checkout', build: '1.2.3' } });
    });

    it('overwrites a property already set through setContext', () => {
      globalContext.setContext({ team: 'checkout' });
      globalContext.setProperty('team', 'payments');

      expect(triggerRum()).toEqual({ context: { team: 'payments' } });
    });

    it('works before any context is set', () => {
      globalContext.setProperty('team', 'checkout');

      expect(triggerRum()).toEqual({ context: { team: 'checkout' } });
    });

    it.each([null, undefined])('removes the property when the value is %j', (value) => {
      globalContext.setContext({ team: 'checkout', build: '1.2.3' });
      globalContext.setProperty('build', value);

      expect(triggerRum()).toEqual({ context: { team: 'checkout' } });
    });

    it('keeps falsy values that are not nullish', () => {
      globalContext.setProperty('retries', 0);
      globalContext.setProperty('label', '');

      expect(triggerRum()).toEqual({ context: { retries: 0, label: '' } });
    });
  });

  describe('removeProperty', () => {
    it('removes only the given property', () => {
      globalContext.setContext({ team: 'checkout', build: '1.2.3' });
      globalContext.removeProperty('build');

      expect(triggerRum()).toEqual({ context: { team: 'checkout' } });
    });

    it('contributes nothing once the last property is removed', () => {
      globalContext.setContext({ team: 'checkout' });
      globalContext.removeProperty('team');

      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });

    it('is a no-op for an unknown key', () => {
      globalContext.setContext({ team: 'checkout' });
      globalContext.removeProperty('unknown');

      expect(triggerRum()).toEqual({ context: { team: 'checkout' } });
    });
  });

  describe('clearContext', () => {
    it('contributes nothing afterwards', () => {
      globalContext.setContext({ team: 'checkout' });
      globalContext.clearContext();

      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });
  });

  describe('getContext', () => {
    it('returns a copy the caller cannot use to mutate the stored context', () => {
      globalContext.setContext({ team: 'checkout' });

      const returned = globalContext.getContext();
      returned.team = 'tampered';

      expect(triggerRum()).toEqual({ context: { team: 'checkout' } });
    });
  });

  describe('renderer events', () => {
    it('contributes the context so RendererPipeline can merge it', () => {
      globalContext.setContext({ team: 'checkout' });

      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.RENDERER })).toEqual({
        context: { team: 'checkout' },
      });
    });
  });

  describe('historical context', () => {
    it('contributes nothing when no context was active at the event start time', () => {
      hooks = createFormatHooks();
      globalContext = new GlobalContext(hooks, createHistory(vi.fn(() => undefined)));

      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum('error')).toEqual({ date: 1 });
    });

    it('uses the context matching the event start time', () => {
      const find = vi.fn(() => ({ team: 'historical' }));
      hooks = createFormatHooks();
      globalContext = new GlobalContext(hooks, createHistory(find));

      expect(triggerRum('error')).toEqual({ context: { team: 'historical' } });
      expect(find).toHaveBeenCalledWith(T0);
    });

    it('uses the current context for view updates', () => {
      const find = vi.fn(() => ({ team: 'historical' }));
      hooks = createFormatHooks();
      globalContext = new GlobalContext(hooks, createHistory(find));
      globalContext.setContext({ team: 'current' });

      expect(triggerRum('view')).toEqual({ context: { team: 'current' } });
      expect(find).not.toHaveBeenCalled();
    });
  });
});

function createHistory(find: ContextHistory['find']): ContextHistory {
  return {
    add: vi.fn(),
    closeActive: vi.fn(),
    closeAndAdd: vi.fn(),
    pruneAndPersist: vi.fn(),
    find,
  };
}
