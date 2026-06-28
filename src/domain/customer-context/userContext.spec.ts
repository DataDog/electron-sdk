import { beforeEach, describe, it, expect, vi } from 'vitest';
import { type TimeStamp } from '@datadog/js-core/time';
import { EventSource } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import { UserContext } from './userContext';
import type { ContextHistory } from './contextManager';

const T0 = 0 as TimeStamp;

describe('UserContext', () => {
  let hooks: FormatHooks;
  let userContext: UserContext;

  function triggerRum() {
    return hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
  }

  function triggerSpan() {
    return hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN });
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

  describe('span metadata', () => {
    it('injects user info into span meta', () => {
      userContext.setContext({
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
        extraInfo: { plan: 'premium', beta: true, count: 2 },
      });

      expect(triggerSpan()).toEqual({
        meta: {
          'meta.usr.id': 'user-1',
          'meta.usr.name': 'Alice',
          'meta.usr.email': 'alice@example.com',
          'meta.usr.plan': 'premium',
          'meta.usr.beta': 'true',
          'meta.usr.count': '2',
        },
      });
    });

    it('does not let extraInfo override standard span meta fields', () => {
      userContext.setContext({ id: 'user-1', name: 'Alice' });
      userContext.addExtraInfo({ id: 'hacked', name: 'hacked' });

      expect(triggerSpan()).toMatchObject({
        meta: {
          'meta.usr.id': 'user-1',
          'meta.usr.name': 'Alice',
        },
      });
    });
  });

  describe('historical context', () => {
    it('uses the user context matching the event start time', () => {
      const find = vi.fn(() => ({ id: 'historical-user', plan: 'premium' }));
      const history = createHistory(find);
      hooks = createFormatHooks();
      userContext = new UserContext(hooks, history);

      expect(triggerRum()).toEqual({ usr: { id: 'historical-user', plan: 'premium' } });
      expect(triggerSpan()).toEqual({
        meta: {
          'meta.usr.id': 'historical-user',
          'meta.usr.plan': 'premium',
        },
      });
      expect(find).toHaveBeenCalledWith(T0);
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
      userContext.addExtraInfo({ plan: 'premium' });

      expect(user).toEqual({ id: 'user-1', name: 'Alice' });
    });

    it('accepts a user without an id', () => {
      // `usr.id` is optional; setUserInfo enforces an id at the public-API level, but the context
      // store itself accepts an id-less user (e.g. attributes attached to an anonymous user).
      userContext.setContext({ name: 'Alice' });

      expect(userContext.getInfo()).toEqual({ name: 'Alice' });
      expect(triggerRum()).toEqual({ usr: { name: 'Alice' } });
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

  describe('setUserInfo', () => {
    it('sets the user when an id is provided', () => {
      userContext.setUserInfo({ id: 'user-1', name: 'Alice' });

      expect(userContext.getInfo()).toEqual({ id: 'user-1', name: 'Alice' });
    });

    it('is ignored when no id is provided', () => {
      userContext.setUserInfo({ name: 'Alice' });

      expect(userContext.getInfo()).toBeUndefined();
    });

    it('is ignored when the id is empty', () => {
      userContext.setUserInfo({ id: '' });

      expect(userContext.getInfo()).toBeUndefined();
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

  describe('addExtraInfo', () => {
    it('adds custom fields to extraInfo', () => {
      userContext.setContext({ id: 'user-1' });
      userContext.addExtraInfo({ plan: 'premium' });

      expect(userContext.getInfo()).toEqual({ id: 'user-1', extraInfo: { plan: 'premium' } });
    });

    it('merges with existing extraInfo', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'free' } });
      userContext.addExtraInfo({ role: 'admin' });

      expect(userContext.getInfo()!.extraInfo).toEqual({ plan: 'free', role: 'admin' });
    });

    it('overwrites an existing custom field', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'free' } });
      userContext.addExtraInfo({ plan: 'premium' });

      expect(userContext.getInfo()!.extraInfo).toEqual({ plan: 'premium' });
    });

    it('does not override standard fields in the emitted event', () => {
      userContext.setContext({ id: 'user-1', name: 'Alice' });
      userContext.addExtraInfo({ id: 'hacked', name: 'hacked' });

      expect(triggerRum()).toEqual({ usr: { id: 'user-1', name: 'Alice' } });
    });

    it('works without a user set (anonymous-id scenario)', () => {
      // `usr.id` is optional, so attributes can be attached to a user whose id is derived from
      // anonymous_id by the backend — matching the mobile SDKs.
      userContext.addExtraInfo({ plan: 'premium' });

      expect(userContext.getInfo()).toEqual({ extraInfo: { plan: 'premium' } });
      expect(triggerRum()).toEqual({ usr: { plan: 'premium' } });
    });

    it('does not leak nested extraInfo mutations after add', () => {
      const nested = { role: 'admin' };
      userContext.setContext({ id: 'user-1' });
      userContext.addExtraInfo({ nested });
      nested.role = 'hacked';

      expect((userContext.getInfo()!.extraInfo!.nested as { role: string }).role).toBe('admin');
    });
  });
});

function createHistory(find: ContextHistory['find']): ContextHistory {
  return {
    add: vi.fn(),
    closeActive: vi.fn(),
    find,
  };
}
