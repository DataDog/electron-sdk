import { beforeEach, describe, it, expect } from 'vitest';
import { type TimeStamp } from '@datadog/browser-core';
import { createFormatHooks, type FormatHooks } from './hooks';
import { UserContext } from './userContext';

const T0 = 0 as TimeStamp;

describe('UserContext', () => {
  let hooks: FormatHooks;
  let userContext: UserContext;

  function triggerRum() {
    return hooks.triggerRum({ eventType: 'view', startTime: T0 });
  }

  beforeEach(() => {
    hooks = createFormatHooks();
    userContext = new UserContext(hooks);
  });

  describe('when neither user nor account is set', () => {
    it('returns SKIPPED', () => {
      hooks.registerRum(() => ({ date: 1 }));
      const result = triggerRum();
      expect(result).toEqual({ date: 1 });
    });
  });

  // --- User Info ---

  describe('setUserInfo', () => {
    it('injects usr into RUM events', () => {
      userContext.setUserInfo({ id: 'user-1', name: 'Alice', email: 'alice@example.com' });

      const result = triggerRum();
      expect(result).toEqual({
        usr: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
      });
    });

    it('includes extraInfo fields in usr', () => {
      userContext.setUserInfo({ id: 'user-1', extraInfo: { plan: 'premium', org: 'acme' } });

      const result = triggerRum();
      expect(result).toEqual({
        usr: { id: 'user-1', plan: 'premium', org: 'acme' },
      });
    });

    it('does not mutate the original user object', () => {
      const user = { id: 'user-1', name: 'Alice' };
      userContext.setUserInfo(user);
      userContext.setUserInfoProperty('plan', 'premium');

      expect(user).toEqual({ id: 'user-1', name: 'Alice' });
    });
  });

  describe('getUserInfo', () => {
    it('returns undefined when no user is set', () => {
      expect(userContext.getUserInfo()).toBeUndefined();
    });

    it('returns a copy of the current user info', () => {
      userContext.setUserInfo({ id: 'user-1', name: 'Alice' });

      const info = userContext.getUserInfo();
      expect(info).toEqual({ id: 'user-1', name: 'Alice' });
    });

    it('does not include extraInfo key when not set', () => {
      userContext.setUserInfo({ id: 'user-1' });

      expect('extraInfo' in userContext.getUserInfo()!).toBe(false);
    });

    it('returns a deep copy that does not affect internal state', () => {
      userContext.setUserInfo({ id: 'user-1', extraInfo: { plan: 'free' } });
      const info = userContext.getUserInfo()!;
      info.extraInfo!.plan = 'hacked';

      expect(userContext.getUserInfo()!.extraInfo!.plan).toBe('free');
    });
  });

  describe('clearUserInfo', () => {
    it('removes usr from RUM events', () => {
      userContext.setUserInfo({ id: 'user-1' });
      userContext.clearUserInfo();

      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });
  });

  describe('setUserInfoProperty', () => {
    it('sets a standard field', () => {
      userContext.setUserInfo({ id: 'user-1' });
      userContext.setUserInfoProperty('name', 'Bob');

      expect(userContext.getUserInfo()).toEqual({ id: 'user-1', name: 'Bob' });
    });

    it('sets a custom field in extraInfo', () => {
      userContext.setUserInfo({ id: 'user-1' });
      userContext.setUserInfoProperty('plan', 'premium');

      expect(userContext.getUserInfo()).toEqual({ id: 'user-1', extraInfo: { plan: 'premium' } });
    });

    it('merges with existing extraInfo', () => {
      userContext.setUserInfo({ id: 'user-1', extraInfo: { plan: 'free' } });
      userContext.setUserInfoProperty('role', 'admin');

      expect(userContext.getUserInfo()!.extraInfo).toEqual({ plan: 'free', role: 'admin' });
    });

    it('is ignored when no user is set', () => {
      userContext.setUserInfoProperty('name', 'Bob');
      expect(userContext.getUserInfo()).toBeUndefined();
    });

    it('is ignored for the required id field', () => {
      userContext.setUserInfo({ id: 'user-1' });
      userContext.setUserInfoProperty('id', 'user-2');

      expect(userContext.getUserInfo()!.id).toBe('user-1');
    });
  });

  describe('removeUserInfoProperty', () => {
    it('removes a standard field', () => {
      userContext.setUserInfo({ id: 'user-1', name: 'Alice' });
      userContext.removeUserInfoProperty('name');

      const info = userContext.getUserInfo()!;
      expect(info.name).toBeUndefined();
      expect('name' in info).toBe(false);
      expect(info.id).toBe('user-1');
    });

    it('is ignored for the required id field', () => {
      userContext.setUserInfo({ id: 'user-1' });
      userContext.removeUserInfoProperty('id');

      expect(userContext.getUserInfo()!.id).toBe('user-1');
    });

    it('removes a custom field from extraInfo', () => {
      userContext.setUserInfo({ id: 'user-1', extraInfo: { plan: 'premium', role: 'admin' } });
      userContext.removeUserInfoProperty('plan');

      expect(userContext.getUserInfo()!.extraInfo).toEqual({ role: 'admin' });
    });

    it('clears extraInfo when the last key is removed', () => {
      userContext.setUserInfo({ id: 'user-1', extraInfo: { plan: 'premium' } });
      userContext.removeUserInfoProperty('plan');

      expect(userContext.getUserInfo()!.extraInfo).toBeUndefined();
    });

    it('is ignored when no user is set', () => {
      userContext.removeUserInfoProperty('name');
      expect(userContext.getUserInfo()).toBeUndefined();
    });
  });

  // --- Account Info ---

  describe('setAccountInfo', () => {
    it('injects account into RUM events', () => {
      userContext.setAccountInfo({ id: 'account-1', name: 'Acme Corp' });

      const result = triggerRum();
      expect(result).toEqual({
        account: { id: 'account-1', name: 'Acme Corp' },
      });
    });

    it('includes extraInfo fields in account', () => {
      userContext.setAccountInfo({ id: 'account-1', extraInfo: { tier: 'enterprise' } });

      const result = triggerRum();
      expect(result).toEqual({
        account: { id: 'account-1', tier: 'enterprise' },
      });
    });

    it('does not mutate the original account object', () => {
      const account = { id: 'account-1', name: 'Acme' };
      userContext.setAccountInfo(account);
      userContext.setAccountInfoProperty('tier', 'enterprise');

      expect(account).toEqual({ id: 'account-1', name: 'Acme' });
    });
  });

  describe('getAccountInfo', () => {
    it('returns undefined when no account is set', () => {
      expect(userContext.getAccountInfo()).toBeUndefined();
    });

    it('returns a copy of the current account info', () => {
      userContext.setAccountInfo({ id: 'account-1', name: 'Acme' });

      expect(userContext.getAccountInfo()).toEqual({ id: 'account-1', name: 'Acme' });
    });

    it('returns a deep copy that does not affect internal state', () => {
      userContext.setAccountInfo({ id: 'account-1', extraInfo: { tier: 'free' } });
      const info = userContext.getAccountInfo()!;
      info.extraInfo!.tier = 'hacked';

      expect(userContext.getAccountInfo()!.extraInfo!.tier).toBe('free');
    });
  });

  describe('clearAccountInfo', () => {
    it('removes account from RUM events', () => {
      userContext.setAccountInfo({ id: 'account-1' });
      userContext.clearAccountInfo();

      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });
  });

  describe('setAccountInfoProperty', () => {
    it('sets a standard field', () => {
      userContext.setAccountInfo({ id: 'account-1' });
      userContext.setAccountInfoProperty('name', 'Acme');

      expect(userContext.getAccountInfo()).toEqual({ id: 'account-1', name: 'Acme' });
    });

    it('sets a custom field in extraInfo', () => {
      userContext.setAccountInfo({ id: 'account-1' });
      userContext.setAccountInfoProperty('tier', 'enterprise');

      expect(userContext.getAccountInfo()).toEqual({ id: 'account-1', extraInfo: { tier: 'enterprise' } });
    });

    it('merges with existing extraInfo', () => {
      userContext.setAccountInfo({ id: 'account-1', extraInfo: { tier: 'free' } });
      userContext.setAccountInfoProperty('region', 'us');

      expect(userContext.getAccountInfo()!.extraInfo).toEqual({ tier: 'free', region: 'us' });
    });

    it('is ignored when no account is set', () => {
      userContext.setAccountInfoProperty('name', 'Acme');
      expect(userContext.getAccountInfo()).toBeUndefined();
    });

    it('is ignored for the required id field', () => {
      userContext.setAccountInfo({ id: 'account-1' });
      userContext.setAccountInfoProperty('id', 'account-2');

      expect(userContext.getAccountInfo()!.id).toBe('account-1');
    });
  });

  describe('removeAccountInfoProperty', () => {
    it('removes a standard field', () => {
      userContext.setAccountInfo({ id: 'account-1', name: 'Acme' });
      userContext.removeAccountInfoProperty('name');

      const info = userContext.getAccountInfo()!;
      expect(info.name).toBeUndefined();
      expect('name' in info).toBe(false);
      expect(info.id).toBe('account-1');
    });

    it('is ignored for the required id field', () => {
      userContext.setAccountInfo({ id: 'account-1' });
      userContext.removeAccountInfoProperty('id');

      expect(userContext.getAccountInfo()!.id).toBe('account-1');
    });

    it('removes a custom field from extraInfo', () => {
      userContext.setAccountInfo({ id: 'account-1', extraInfo: { tier: 'enterprise', region: 'us' } });
      userContext.removeAccountInfoProperty('tier');

      expect(userContext.getAccountInfo()!.extraInfo).toEqual({ region: 'us' });
    });

    it('clears extraInfo when the last key is removed', () => {
      userContext.setAccountInfo({ id: 'account-1', extraInfo: { tier: 'enterprise' } });
      userContext.removeAccountInfoProperty('tier');

      expect(userContext.getAccountInfo()!.extraInfo).toBeUndefined();
    });

    it('is ignored when no account is set', () => {
      userContext.removeAccountInfoProperty('name');
      expect(userContext.getAccountInfo()).toBeUndefined();
    });
  });

  // --- Combined ---

  describe('user and account together', () => {
    it('injects both usr and account into RUM events', () => {
      userContext.setUserInfo({ id: 'user-1', name: 'Alice' });
      userContext.setAccountInfo({ id: 'account-1', name: 'Acme' });

      const result = triggerRum();
      expect(result).toEqual({
        usr: { id: 'user-1', name: 'Alice' },
        account: { id: 'account-1', name: 'Acme' },
      });
    });
  });
});
