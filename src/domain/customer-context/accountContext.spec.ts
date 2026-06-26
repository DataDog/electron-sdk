import { beforeEach, describe, it, expect } from 'vitest';
import { type TimeStamp } from '@datadog/js-core/time';
import { EventSource } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import { AccountContext } from './accountContext';

const T0 = 0 as TimeStamp;

describe('AccountContext', () => {
  let hooks: FormatHooks;
  let accountContext: AccountContext;

  function triggerRum() {
    return hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
  }

  beforeEach(() => {
    hooks = createFormatHooks();
    accountContext = new AccountContext(hooks);
  });

  describe('when account is not set', () => {
    it('returns SKIPPED', () => {
      hooks.registerRum(() => ({ date: 1 }));
      const result = triggerRum();
      expect(result).toEqual({ date: 1 });
    });
  });

  describe('setContext', () => {
    it('injects account into RUM events', () => {
      accountContext.setContext({ id: 'account-1', name: 'Acme Corp' });

      const result = triggerRum();
      expect(result).toEqual({
        account: { id: 'account-1', name: 'Acme Corp' },
      });
    });

    it('includes extraInfo fields in account', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { tier: 'enterprise' } });

      const result = triggerRum();
      expect(result).toEqual({
        account: { id: 'account-1', tier: 'enterprise' },
      });
    });

    it('does not mutate the original account object', () => {
      const account = { id: 'account-1', name: 'Acme' };
      accountContext.setContext(account);
      accountContext.setContextProperty('tier', 'enterprise');

      expect(account).toEqual({ id: 'account-1', name: 'Acme' });
    });

    it('is ignored when id is missing or empty', () => {
      accountContext.setContext({ id: '' });
      expect(accountContext.getInfo()).toBeUndefined();
    });

    it('is ignored when id is not a string', () => {
      accountContext.setContext({ id: 123 as unknown as string });
      expect(accountContext.getInfo()).toBeUndefined();
    });

    it('keeps a set standard field but lets extraInfo fill an unset one', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { id: 'injected', name: 'injected' } });

      const result = triggerRum();
      // id is set, so it wins over extraInfo; name is unset, so extraInfo fills it.
      expect(result).toEqual({ account: { id: 'account-1', name: 'injected' } });
    });

    it('does not leak nested extraInfo mutations after set', () => {
      const nested = { tier: 'enterprise' };
      accountContext.setContext({ id: 'account-1', extraInfo: { nested } });
      nested.tier = 'hacked';

      expect((accountContext.getInfo()!.extraInfo!.nested as { tier: string }).tier).toBe('enterprise');
    });
  });

  describe('getInfo', () => {
    it('returns undefined when no account is set', () => {
      expect(accountContext.getInfo()).toBeUndefined();
    });

    it('returns a copy of the current account info', () => {
      accountContext.setContext({ id: 'account-1', name: 'Acme' });

      expect(accountContext.getInfo()).toEqual({ id: 'account-1', name: 'Acme' });
    });

    it('does not retain unset standard fields passed as undefined', () => {
      accountContext.setContext({ id: 'account-1', name: undefined });

      const info = accountContext.getInfo()!;
      expect(info).toEqual({ id: 'account-1' });
      expect('name' in info).toBe(false);
    });

    it('returns a deep copy that does not affect internal state', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { tier: 'free' } });
      const info = accountContext.getInfo()!;
      info.extraInfo!.tier = 'hacked';

      expect(accountContext.getInfo()!.extraInfo!.tier).toBe('free');
    });
  });

  describe('clearContext', () => {
    it('removes account from RUM events', () => {
      accountContext.setContext({ id: 'account-1' });
      accountContext.clearContext();

      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });
  });

  describe('setContextProperty', () => {
    it('sets a standard field', () => {
      accountContext.setContext({ id: 'account-1' });
      accountContext.setContextProperty('name', 'Acme');

      expect(accountContext.getInfo()).toEqual({ id: 'account-1', name: 'Acme' });
    });

    it('sets a custom field in extraInfo', () => {
      accountContext.setContext({ id: 'account-1' });
      accountContext.setContextProperty('tier', 'enterprise');

      expect(accountContext.getInfo()).toEqual({ id: 'account-1', extraInfo: { tier: 'enterprise' } });
    });

    it('merges with existing extraInfo', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { tier: 'free' } });
      accountContext.setContextProperty('region', 'us');

      expect(accountContext.getInfo()!.extraInfo).toEqual({ tier: 'free', region: 'us' });
    });

    it('is ignored when no account is set', () => {
      accountContext.setContextProperty('name', 'Acme');
      expect(accountContext.getInfo()).toBeUndefined();
    });

    it('is ignored for a custom property when no account is set', () => {
      accountContext.setContextProperty('tier', 'enterprise');

      // A custom attribute alone (no id) would emit account:{tier} and violate the schema.
      expect(accountContext.getInfo()).toBeUndefined();
      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });

    it('is ignored for the required id field', () => {
      accountContext.setContext({ id: 'account-1' });
      accountContext.setContextProperty('id', 'account-2');

      expect(accountContext.getInfo()!.id).toBe('account-1');
    });
  });

  describe('removeContextProperty', () => {
    it('removes a standard field', () => {
      accountContext.setContext({ id: 'account-1', name: 'Acme' });
      accountContext.removeContextProperty('name');

      const info = accountContext.getInfo()!;
      expect(info.name).toBeUndefined();
      expect('name' in info).toBe(false);
      expect(info.id).toBe('account-1');
    });

    it('is ignored for the required id field', () => {
      accountContext.setContext({ id: 'account-1' });
      accountContext.removeContextProperty('id');

      expect(accountContext.getInfo()!.id).toBe('account-1');
    });

    it('removes a custom field from extraInfo', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { tier: 'enterprise', region: 'us' } });
      accountContext.removeContextProperty('tier');

      expect(accountContext.getInfo()!.extraInfo).toEqual({ region: 'us' });
    });

    it('clears extraInfo when the last key is removed', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { tier: 'enterprise' } });
      accountContext.removeContextProperty('tier');

      expect(accountContext.getInfo()!.extraInfo).toBeUndefined();
    });

    it('is ignored when no account is set', () => {
      accountContext.removeContextProperty('name');
      expect(accountContext.getInfo()).toBeUndefined();
    });
  });
});
