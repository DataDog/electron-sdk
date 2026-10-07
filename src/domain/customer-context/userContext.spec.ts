import { beforeEach, describe, it, expect, vi } from 'vitest';
import { type TimeStamp } from '@datadog/js-core/time';
import { EventSource } from '../../event';
import { createFormatHooks, type FormatHooks, type RumEventType } from '../../assembly';
import { UserContext, type UserInfo } from './userContext';
import type { ContextHistory } from './contextManager';

const T0 = 0 as TimeStamp;

describe('UserContext', () => {
  let hooks: FormatHooks;
  let userContext: UserContext;

  function triggerRum(eventType: RumEventType = 'view') {
    return hooks.triggerRum({ eventType, startTime: T0, source: EventSource.MAIN });
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
          'usr.id': 'user-1',
          'usr.name': 'Alice',
          'usr.email': 'alice@example.com',
          'usr.plan': 'premium',
          'usr.beta': 'true',
          'usr.count': '2',
        },
      });
    });

    it('skips non-serializable extraInfo values without throwing', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'premium', count: BigInt(1) } });

      expect(() => triggerSpan()).not.toThrow();
      expect(triggerSpan()).toEqual({
        meta: { 'usr.id': 'user-1', 'usr.plan': 'premium' },
      });
    });

    it('does not let extraInfo override standard span meta fields', () => {
      userContext.setContext({ id: 'user-1', name: 'Alice' });
      userContext.addExtraInfo({ id: 'hacked', name: 'hacked' });

      expect(triggerSpan()).toMatchObject({
        meta: {
          'usr.id': 'user-1',
          'usr.name': 'Alice',
        },
      });
    });
  });

  describe('historical context', () => {
    it('emits nothing when no context was active at the event start time', () => {
      const find = vi.fn(() => undefined);
      const history = createHistory(find);
      hooks = createFormatHooks();
      userContext = new UserContext(hooks, history);

      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum('error')).toEqual({ date: 1 });
    });

    it('uses the user context matching the event start time', () => {
      const find = vi.fn(() => ({ id: 'historical-user', plan: 'premium' }));
      const history = createHistory(find);
      hooks = createFormatHooks();
      userContext = new UserContext(hooks, history);

      expect(triggerRum('error')).toEqual({ usr: { id: 'historical-user', plan: 'premium' } });
      expect(triggerSpan()).toEqual({
        meta: {
          'usr.id': 'historical-user',
          'usr.plan': 'premium',
        },
      });
      expect(find).toHaveBeenCalledWith(T0);
    });

    it('uses the current user context for view updates', () => {
      const find = vi.fn(() => ({ id: 'historical-user' }));
      const history = createHistory(find);
      hooks = createFormatHooks();
      userContext = new UserContext(hooks, history);
      userContext.setContext({ id: 'current-user' });

      expect(triggerRum('view')).toEqual({ usr: { id: 'current-user' } });
      expect(find).not.toHaveBeenCalled();
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

    it('excludes standard fields from extraInfo', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { id: 'injected', name: 'injected' } });

      expect(userContext.getInfo()).toEqual({ id: 'user-1' });
      expect(triggerRum()).toEqual({ usr: { id: 'user-1' } });
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

    it('does not retain optional standard fields passed as null', () => {
      userContext.setContext({ id: 'user-1', name: null, email: null } as unknown as UserInfo);

      expect(userContext.getInfo()).toEqual({ id: 'user-1' });
      expect(triggerRum()).toEqual({ usr: { id: 'user-1' } });
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

    it('removes an existing custom field when the new value is null', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'free', role: 'admin' } });
      userContext.addExtraInfo({ plan: null, cohort: 'a' });

      expect(userContext.getInfo()).toEqual({ id: 'user-1', extraInfo: { role: 'admin', cohort: 'a' } });
      expect(triggerRum()).toEqual({ usr: { id: 'user-1', role: 'admin', cohort: 'a' } });
      expect(triggerSpan()).toEqual({
        meta: {
          'usr.id': 'user-1',
          'usr.role': 'admin',
          'usr.cohort': 'a',
        },
      });
    });

    it('does not remove an existing custom field when the new value is undefined', () => {
      userContext.setContext({ id: 'user-1', extraInfo: { plan: 'premium' } });
      userContext.addExtraInfo({ plan: undefined });

      expect(userContext.getInfo()).toEqual({ id: 'user-1', extraInfo: { plan: 'premium' } });
      expect(triggerRum()).toEqual({ usr: { id: 'user-1', plan: 'premium' } });
    });

    it('does not add standard fields through extraInfo', () => {
      userContext.setContext({ id: 'user-1' });
      userContext.addExtraInfo({ id: 'hacked', name: 'hacked', email: 'hacked@example.com' });

      expect(userContext.getInfo()).toEqual({ id: 'user-1' });
      expect(triggerRum()).toEqual({ usr: { id: 'user-1' } });
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
    closeAndAdd: vi.fn(),
    pruneAndPersist: vi.fn(),
    find,
  };
}
