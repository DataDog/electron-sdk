import { SKIPPED } from '@datadog/js-core/assembly';
import { isEmptyObject } from '@datadog/browser-core';
import {
  ContextManager,
  toSpanMeta,
  initContextWithHistory,
  type ContextHistory,
  type PropertiesConfig,
} from './contextManager';
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
 * Stores account information and injects it as `account` into RUM events and `account.*` tags into spans.
 */
export class AccountContext extends ContextManager<AccountInfo> {
  static init(hooks: FormatHooks): Promise<AccountContext> {
    return initContextWithHistory((history) => new AccountContext(hooks, history), ACCOUNT_CONTEXT_HISTORY_FILE_NAME);
  }

  constructor(hooks: FormatHooks, history?: ContextHistory) {
    super('account', ACCOUNT_PROPERTIES, history);
    hooks.registerRum(({ eventType, startTime }) => {
      // View updates retain the view's original start time, but should reflect the customer context
      // active when the update is emitted. Other events use history for start-time attribution.
      const context = this.getContext(eventType === 'view' ? undefined : startTime);
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
