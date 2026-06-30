import { SKIPPED } from '@datadog/js-core/assembly';
import { isEmptyObject } from '@datadog/browser-core';
import { ContextManager, toSpanMeta, type ContextHistory, type PropertiesConfig } from './contextManager';
import type { FormatHooks } from '../../assembly';

export interface AccountInfo {
  id: string;
  name?: string;
  extraInfo?: Record<string, unknown>;
}

const ACCOUNT_PROPERTIES: PropertiesConfig = {
  id: { required: true, type: 'string' },
  name: { type: 'string' },
};

export const ACCOUNT_CONTEXT_HISTORY_FILE_NAME = '_dd_account_context_history';

/**
 * Stores account information and injects it as `account` into RUM events and `meta.account.*` into spans.
 */
export class AccountContext extends ContextManager<AccountInfo> {
  static async init(hooks: FormatHooks): Promise<AccountContext> {
    const { initContextHistory } = await import('./contextHistory');
    const history = await initContextHistory(ACCOUNT_CONTEXT_HISTORY_FILE_NAME);
    return new AccountContext(hooks, history);
  }

  constructor(hooks: FormatHooks, history?: ContextHistory) {
    super('account', ACCOUNT_PROPERTIES, history);
    hooks.registerRum(({ startTime }) => {
      const context = this.getContext(startTime);
      if (isEmptyObject(context)) return SKIPPED;
      return { account: context };
    });
    hooks.registerSpan(({ startTime }) => {
      const context = this.getContext(startTime);
      if (isEmptyObject(context)) return SKIPPED;
      return { meta: toSpanMeta('account', context) };
    });
  }
}
