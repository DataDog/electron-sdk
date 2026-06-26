import { beforeEach, describe, it, expect } from 'vitest';
import { type TimeStamp } from '@datadog/js-core/time';
import { EventSource } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import { UserContext } from './userContext';

const T0 = 0 as TimeStamp;

describe('UserContext', () => {
  let hooks: FormatHooks;
  let userContext: UserContext;

  function triggerRum() {
    return hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
  }

  beforeEach(() => {
    hooks = createFormatHooks();
    userContext = new UserContext(hooks);
  });

  describe('when user is not set', () => {
    it('returns SKIPPED', () => {
      hooks.registerRum(() => ({ date: 1 }));
      const result = triggerRum();
      expect(result).toEqual({ date: 1 });
    });
  });

  describe('setContext', () => {
    it('injects usr into RUM events', () => {
      userContext.setContext({ id: 'user-1', name: 'Alice', email: 'alice@example.com' });

      const result = triggerRum();
      expect(result).toEqual({
        usr: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
      });
    });

    it('includes extraInfo fields in usr', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'premium', org: 'acme' } });

      const result = triggerRum();
      expect(result).toEqual({
        usr: { id: 'user-1', plan: 'premium', org: 'acme' },
      });
    });

    it('does not mutate the original user object', () => {
      const user = { id: 'user-1', name: 'Alice' };
      userContext.setContext(user);
      userContext.setContextProperty('plan', 'premium');

      expect(user).toEqual({ id: 'user-1', name: 'Alice' });
    });

    it('is ignored when id is missing or empty', () => {
      userContext.setContext({ id: '' });
      expect(userContext.getInfo()).toBeUndefined();
    });

    it('is ignored when id is not a string', () => {
      userContext.setContext({ id: 123 as unknown as string });
      expect(userContext.getInfo()).toBeUndefined();
    });

    it('keeps a set standard field but lets extraInfo fill an unset one', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { id: 'injected', name: 'injected' } });

      const result = triggerRum();
      // id is set, so it wins over extraInfo; name is unset, so extraInfo fills it.
      expect(result).toEqual({ usr: { id: 'user-1', name: 'injected' } });
    });

    it('does not leak nested extraInfo mutations after set', () => {
      const nested = { role: 'admin' };
      userContext.setContext({ id: 'user-1', extraInfo: { nested } });
      nested.role = 'hacked';

      expect((userContext.getInfo()!.extraInfo!.nested as { role: string }).role).toBe('admin');
    });
  });

  describe('getInfo', () => {
    it('returns undefined when no user is set', () => {
      expect(userContext.getInfo()).toBeUndefined();
    });

    it('returns a copy of the current user info', () => {
      userContext.setContext({ id: 'user-1', name: 'Alice' });

      const info = userContext.getInfo();
      expect(info).toEqual({ id: 'user-1', name: 'Alice' });
    });

    it('does not include extraInfo key when not set', () => {
      userContext.setContext({ id: 'user-1' });

      expect('extraInfo' in userContext.getInfo()!).toBe(false);
    });

    it('does not retain unset standard fields passed as undefined', () => {
      userContext.setContext({ id: 'user-1', name: undefined });

      const info = userContext.getInfo()!;
      expect(info).toEqual({ id: 'user-1' });
      expect('name' in info).toBe(false);
    });

    it('returns a deep copy that does not affect internal state', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'free' } });
      const info = userContext.getInfo()!;
      info.extraInfo!.plan = 'hacked';

      expect(userContext.getInfo()!.extraInfo!.plan).toBe('free');
    });
  });

  describe('clearContext', () => {
    it('removes usr from RUM events', () => {
      userContext.setContext({ id: 'user-1' });
      userContext.clearContext();

      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });
  });

  describe('setContextProperty', () => {
    it('sets a standard field', () => {
      userContext.setContext({ id: 'user-1' });
      userContext.setContextProperty('name', 'Bob');

      expect(userContext.getInfo()).toEqual({ id: 'user-1', name: 'Bob' });
    });

    it('sets a custom field in extraInfo', () => {
      userContext.setContext({ id: 'user-1' });
      userContext.setContextProperty('plan', 'premium');

      expect(userContext.getInfo()).toEqual({ id: 'user-1', extraInfo: { plan: 'premium' } });
    });

    it('merges with existing extraInfo', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'free' } });
      userContext.setContextProperty('role', 'admin');

      expect(userContext.getInfo()!.extraInfo).toEqual({ plan: 'free', role: 'admin' });
    });

    it('is ignored when no user is set', () => {
      userContext.setContextProperty('name', 'Bob');
      expect(userContext.getInfo()).toBeUndefined();
    });

    it('is ignored for a custom property when no user is set', () => {
      userContext.setContextProperty('plan', 'premium');

      // A custom attribute alone (no id) would emit usr:{plan} and violate the schema.
      expect(userContext.getInfo()).toBeUndefined();
      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });

    it('is ignored for the required id field', () => {
      userContext.setContext({ id: 'user-1' });
      userContext.setContextProperty('id', 'user-2');

      expect(userContext.getInfo()!.id).toBe('user-1');
    });
  });

  describe('removeContextProperty', () => {
    it('removes a standard field', () => {
      userContext.setContext({ id: 'user-1', name: 'Alice' });
      userContext.removeContextProperty('name');

      const info = userContext.getInfo()!;
      expect(info.name).toBeUndefined();
      expect('name' in info).toBe(false);
      expect(info.id).toBe('user-1');
    });

    it('is ignored for the required id field', () => {
      userContext.setContext({ id: 'user-1' });
      userContext.removeContextProperty('id');

      expect(userContext.getInfo()!.id).toBe('user-1');
    });

    it('removes a custom field from extraInfo', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'premium', role: 'admin' } });
      userContext.removeContextProperty('plan');

      expect(userContext.getInfo()!.extraInfo).toEqual({ role: 'admin' });
    });

    it('clears extraInfo when the last key is removed', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'premium' } });
      userContext.removeContextProperty('plan');

      expect(userContext.getInfo()!.extraInfo).toBeUndefined();
    });

    it('is ignored when no user is set', () => {
      userContext.removeContextProperty('name');
      expect(userContext.getInfo()).toBeUndefined();
    });
  });
});
