import { timeStampNow } from '@datadog/js-core/time';
import { ContextManager, type Context, type PropertiesConfig } from './contextManager';
import type { FormatHooks } from '../../assembly';
import type { ContextHistoryFactory } from '../tracking-consent';
import { SESSION_TIME_OUT_DELAY } from '../session';
import { registerContextHooks, type ContextHistory } from './registerContextHooks';

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
  static async init(hooks: FormatHooks, histories: ContextHistoryFactory): Promise<AccountContext> {
    const history = await histories.create<Context>(ACCOUNT_CONTEXT_HISTORY_FILE_NAME, SESSION_TIME_OUT_DELAY);
    return new AccountContext(hooks, history);
  }

  constructor(hooks: FormatHooks, history: ContextHistory) {
    super('account', ACCOUNT_PROPERTIES, (context) => history.set(context, timeStampNow()));
    registerContextHooks(hooks, history, () => this.getContext(), 'account');
  }
}
