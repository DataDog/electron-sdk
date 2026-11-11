import { display as browserDisplay, SANITIZE_DEFAULT_MAX_CHARACTER_COUNT } from '@datadog/browser-core';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { display } from '../../tools/display';
import { type TimeStamp } from '@datadog/js-core/time';
import { EventSource } from '../../event';
import { createFormatHooks, type FormatHooks, type RumEventType } from '../../assembly';
import { AccountContext, type AccountInfo } from './accountContext';
import type { ContextHistory } from './contextManager';

const T0 = 0 as TimeStamp;

describe('AccountContext', () => {
  let hooks: FormatHooks;
  let accountContext: AccountContext;

  function triggerRum(eventType: RumEventType = 'view') {
    return hooks.triggerRum({ eventType, startTime: T0, source: EventSource.MAIN });
  }

  function triggerSpan() {
    return hooks.triggerSpan({ startTime: T0, source: EventSource.MAIN });
  }

  beforeEach(() => {
    vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    hooks = createFormatHooks();
    accountContext = new AccountContext(hooks);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('sanitization at mutation time', () => {
    it.each(['id', 'name'] as const)('rejects an oversized %s atomically without logging its value', (field) => {
      const browserWarning = vi.spyOn(browserDisplay, 'warn').mockImplementation(() => undefined);
      const history = createHistory(vi.fn());
      accountContext = new AccountContext(hooks, history);
      const original = { id: 'original', name: 'Original', extraInfo: { plan: 'paid' } };
      accountContext.setContext(original);
      accountContext.setContext({
        id: 'replacement',
        [field]: 'x'.repeat(SANITIZE_DEFAULT_MAX_CHARACTER_COUNT),
        extraInfo: { plan: 'other' },
      });
      expect(accountContext.getInfo()).toEqual(original);
      expect(history.closeAndAdd).toHaveBeenCalledOnce();
      expect(history.closeActive).not.toHaveBeenCalled();
      expect(display.warn).toHaveBeenCalledExactlyOnceWith(
        `The property "${field}" of account exceeds the context size limit; the context will not be updated.`
      );
      expect(browserWarning).not.toHaveBeenCalled();
    });

    it.each(['id', 'name'] as const)('counts JSON escaping at the %s size boundary', (field) => {
      const browserWarning = vi.spyOn(browserDisplay, 'warn').mockImplementation(() => undefined);
      const boundary = 'x'.repeat(SANITIZE_DEFAULT_MAX_CHARACTER_COUNT - 2);
      accountContext.setContext({ id: 'customer-1', [field]: boundary });
      expect(accountContext.getInfo()?.[field]).toBe(boundary);
      accountContext.setContext({ id: 'customer-1', [field]: '"'.repeat(SANITIZE_DEFAULT_MAX_CHARACTER_COUNT / 2) });
      expect(accountContext.getInfo()?.[field]).toBe(boundary);
      expect(display.warn).toHaveBeenCalledExactlyOnceWith(
        `The property "${field}" of account exceeds the context size limit; the context will not be updated.`
      );
      expect(browserWarning).not.toHaveBeenCalled();
    });

    it.each([false, true])('uses space freed by a same-call shrink, shrink first: %s', (shrinkFirst) => {
      accountContext.setContext({ id: 'customer-1', extraInfo: { blob: 'x'.repeat(200_000), existing: 'old' } });
      const additions = { note: 'y'.repeat(50_000), existing: 'z'.repeat(50_000) };
      accountContext.addExtraInfo(shrinkFirst ? { blob: 'short', ...additions } : { ...additions, blob: 'short' });
      expect(accountContext.getInfo()?.extraInfo).toEqual({ blob: 'short', ...additions });
      expect(display.warn).not.toHaveBeenCalled();
    });

    it('preserves accepted extras and history when replacing an early key exceeds the budget', () => {
      vi.spyOn(browserDisplay, 'warn').mockImplementation(() => undefined);
      const history = createHistory(vi.fn());
      accountContext = new AccountContext(hooks, history);
      accountContext.setContext({ id: 'customer-1', extraInfo: { first: 'old', second: 'kept' } });
      accountContext.addExtraInfo({ first: 'x'.repeat(SANITIZE_DEFAULT_MAX_CHARACTER_COUNT + 1), third: 'new' });
      expect(accountContext.getInfo()).toEqual({
        id: 'customer-1',
        extraInfo: { first: 'old', second: 'kept', third: 'new' },
      });
      expect(history.closeAndAdd).toHaveBeenLastCalledWith(
        { id: 'customer-1', first: 'old', second: 'kept', third: 'new' },
        expect.any(Number)
      );
    });

    it('keeps later extras when an earlier extra does not fit on set', () => {
      vi.spyOn(browserDisplay, 'warn').mockImplementation(() => undefined);
      accountContext.setContext({
        id: 'customer-1',
        extraInfo: {
          huge: { nested: 'x'.repeat(SANITIZE_DEFAULT_MAX_CHARACTER_COUNT + 1) },
          after: 'kept',
          nullable: null,
        },
      });
      expect(accountContext.getInfo()?.extraInfo).toEqual({ after: 'kept', nullable: null });
    });

    it('stores bounded extras separately from identity and shares them across event types', () => {
      const warning = vi.mocked(display.warn);
      accountContext.setContext({
        id: 'customer-1',
        name: 'Customer',
        extraInfo: { huge: 'x'.repeat(SANITIZE_DEFAULT_MAX_CHARACTER_COUNT + 1) },
      });
      expect(accountContext.getInfo()).toEqual({ id: 'customer-1', name: 'Customer' });
      expect(triggerRum()).toMatchObject({ account: { id: 'customer-1', name: 'Customer' } });
      expect(hooks.triggerLogs({ startTime: T0, source: EventSource.RENDERER })).toEqual({
        account: { id: 'customer-1', name: 'Customer' },
      });
      expect(triggerSpan()).toEqual({ meta: { 'account.id': 'customer-1', 'account.name': 'Customer' } });
      expect(warning).toHaveBeenCalledOnce();
    });

    it('bounds accumulated extras and sanitizes cycles before storing them', () => {
      vi.spyOn(browserDisplay, 'warn').mockImplementation(() => undefined);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      accountContext.setContext({ id: 'customer-1', extraInfo: { cyclic, first: 'x'.repeat(120_000) } });
      accountContext.addExtraInfo({ second: 'x'.repeat(120_000), id: 'spoofed' });
      expect(accountContext.getInfo()?.id).toBe('customer-1');
      expect(accountContext.getInfo()?.extraInfo?.second).toBeUndefined();
      expect(() => JSON.stringify(accountContext.getInfo())).not.toThrow();
      accountContext.addExtraInfo({ first: null, after: 'kept' });
      expect(accountContext.getInfo()?.extraInfo).toMatchObject({ after: 'kept' });
      expect(accountContext.getInfo()?.extraInfo).not.toHaveProperty('first');
    });
  });

  describe('when account is not set', () => {
    it('returns SKIPPED', () => {
      hooks.registerRum(() => ({ date: 1 }));
      const result = triggerRum();
      expect(result).toEqual({ date: 1 });
    });
  });

  describe('span metadata', () => {
    it('injects account info into span meta', () => {
      accountContext.setContext({
        id: 'account-1',
        name: 'Acme Corp',
        extraInfo: { tier: 'enterprise', paid: true, seats: 10 },
      });

      expect(triggerSpan()).toEqual({
        meta: {
          'account.id': 'account-1',
          'account.name': 'Acme Corp',
          'account.tier': 'enterprise',
          'account.paid': 'true',
          'account.seats': '10',
        },
      });
    });

    it('does not let extraInfo override standard span meta fields', () => {
      accountContext.setContext({ id: 'account-1', name: 'Acme' });
      accountContext.addExtraInfo({ id: 'hacked', name: 'hacked' });

      expect(triggerSpan()).toMatchObject({
        meta: {
          'account.id': 'account-1',
          'account.name': 'Acme',
        },
      });
    });
  });

  describe('historical context', () => {
    it('emits nothing when no context was active at the event start time', () => {
      const find = vi.fn(() => undefined);
      const history = createHistory(find);
      hooks = createFormatHooks();
      accountContext = new AccountContext(hooks, history);

      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum('error')).toEqual({ date: 1 });
    });

    it('uses the account context matching the event start time', () => {
      const find = vi.fn(() => ({ id: 'historical-account', tier: 'enterprise' }));
      const history = createHistory(find);
      hooks = createFormatHooks();
      accountContext = new AccountContext(hooks, history);

      expect(triggerRum('error')).toEqual({ account: { id: 'historical-account', tier: 'enterprise' } });
      expect(triggerSpan()).toEqual({
        meta: {
          'account.id': 'historical-account',
          'account.tier': 'enterprise',
        },
      });
      expect(find).toHaveBeenCalledWith(T0);
    });

    it('uses the current account context for view updates', () => {
      const find = vi.fn(() => ({ id: 'historical-account' }));
      const history = createHistory(find);
      hooks = createFormatHooks();
      accountContext = new AccountContext(hooks, history);
      accountContext.setContext({ id: 'current-account' });

      expect(triggerRum('view')).toEqual({ account: { id: 'current-account' } });
      expect(find).not.toHaveBeenCalled();
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
      accountContext.addExtraInfo({ tier: 'enterprise' });

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

    it('excludes standard fields from extraInfo', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { id: 'injected', name: 'injected' } });

      expect(accountContext.getInfo()).toEqual({ id: 'account-1' });
      expect(triggerRum()).toEqual({ account: { id: 'account-1' } });
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

    it('does not retain optional standard fields passed as null', () => {
      accountContext.setContext({ id: 'account-1', name: null } as unknown as AccountInfo);

      expect(accountContext.getInfo()).toEqual({ id: 'account-1' });
      expect(triggerRum()).toEqual({ account: { id: 'account-1' } });
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

  describe('addExtraInfo', () => {
    it('adds custom fields to extraInfo', () => {
      accountContext.setContext({ id: 'account-1' });
      accountContext.addExtraInfo({ tier: 'enterprise' });

      expect(accountContext.getInfo()).toEqual({ id: 'account-1', extraInfo: { tier: 'enterprise' } });
    });

    it('merges with existing extraInfo', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { tier: 'free' } });
      accountContext.addExtraInfo({ region: 'us' });

      expect(accountContext.getInfo()!.extraInfo).toEqual({ tier: 'free', region: 'us' });
    });

    it('overwrites an existing custom field', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { tier: 'free' } });
      accountContext.addExtraInfo({ tier: 'enterprise' });

      expect(accountContext.getInfo()!.extraInfo).toEqual({ tier: 'enterprise' });
    });

    it('removes an existing custom field when the new value is null', () => {
      accountContext.setContext({ id: 'account-1', extraInfo: { tier: 'free', region: 'us' } });
      accountContext.addExtraInfo({ tier: null, plan: 'pro' });

      expect(accountContext.getInfo()).toEqual({ id: 'account-1', extraInfo: { region: 'us', plan: 'pro' } });
      expect(triggerRum()).toEqual({ account: { id: 'account-1', region: 'us', plan: 'pro' } });
      expect(triggerSpan()).toEqual({
        meta: {
          'account.id': 'account-1',
          'account.region': 'us',
          'account.plan': 'pro',
        },
      });
    });

    it('does not add standard fields through extraInfo', () => {
      accountContext.setContext({ id: 'account-1' });
      accountContext.addExtraInfo({ id: 'hacked', name: 'hacked' });

      expect(accountContext.getInfo()).toEqual({ id: 'account-1' });
      expect(triggerRum()).toEqual({ account: { id: 'account-1' } });
    });

    it('is ignored when no account is set', () => {
      accountContext.addExtraInfo({ tier: 'enterprise' });

      // A custom attribute alone (no id) would emit account:{tier} and violate the schema.
      expect(accountContext.getInfo()).toBeUndefined();
      hooks.registerRum(() => ({ date: 1 }));
      expect(triggerRum()).toEqual({ date: 1 });
    });

    it('does not leak nested extraInfo mutations after add', () => {
      const nested = { tier: 'enterprise' };
      accountContext.setContext({ id: 'account-1' });
      accountContext.addExtraInfo({ nested });
      nested.tier = 'hacked';

      expect((accountContext.getInfo()!.extraInfo!.nested as { tier: string }).tier).toBe('enterprise');
    });
  });
});

function createHistory(find: ContextHistory['find']) {
  return {
    add: vi.fn(),
    closeActive: vi.fn(),
    closeAndAdd: vi.fn(),
    pruneAndPersist: vi.fn(),
    find,
  } satisfies ContextHistory;
}
