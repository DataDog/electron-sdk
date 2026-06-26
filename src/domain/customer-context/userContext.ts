import { SKIPPED } from '@datadog/js-core/assembly';
import { ContextManager, type PropertiesConfig } from './contextManager';
import type { FormatHooks } from '../../assembly';

export interface UserInfo {
  id: string;
  name?: string;
  email?: string;
  extraInfo?: Record<string, unknown>;
}

const USER_PROPERTIES: PropertiesConfig = {
  id: { required: true, type: 'string' },
  name: { type: 'string' },
  email: { type: 'string' },
};
const USER_STANDARD_KEYS = new Set(Object.keys(USER_PROPERTIES));
const USER_PROTECTED_KEYS = new Set(['id']);

/**
 * Stores user information and injects it as `usr` into RUM events via format hooks.
 */
export class UserContext extends ContextManager<UserInfo> {
  constructor(hooks: FormatHooks) {
    super('user', USER_PROPERTIES, USER_STANDARD_KEYS, USER_PROTECTED_KEYS);
    hooks.registerRum(() => {
      if (this.isEmpty()) return SKIPPED;
      return { usr: this.getContext() };
    });
  }
}
