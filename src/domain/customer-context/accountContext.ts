import { SKIPPED } from '@datadog/js-core/assembly';
import { ContextManager, type PropertiesConfig } from './contextManager';
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
const ACCOUNT_STANDARD_KEYS = new Set(Object.keys(ACCOUNT_PROPERTIES));
const ACCOUNT_PROTECTED_KEYS = new Set(['id']);

/**
 * Stores account information and injects it as `account` into RUM events via format hooks.
 */
export class AccountContext extends ContextManager<AccountInfo> {
  constructor(hooks: FormatHooks) {
    super('account', ACCOUNT_PROPERTIES, ACCOUNT_STANDARD_KEYS, ACCOUNT_PROTECTED_KEYS);
    hooks.registerRum(() => {
      if (this.isEmpty()) return SKIPPED;
      return { account: this.getContext() };
    });
  }
}
