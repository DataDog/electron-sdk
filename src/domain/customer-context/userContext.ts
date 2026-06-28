import { SKIPPED } from '@datadog/js-core/assembly';
import { isEmptyObject } from '@datadog/browser-core';
import { ContextManager, toSpanMeta, type ContextHistory, type PropertiesConfig } from './contextManager';
import { displayWarn } from '../../tools/display';
import type { FormatHooks } from '../../assembly';

export interface UserInfo {
  id?: string;
  name?: string;
  email?: string;
  extraInfo?: Record<string, unknown>;
}

// `id` is intentionally NOT marked required here: the RUM schema makes `usr.id` optional (unlike
// `account.id`), so an id-less user carrying only attributes is valid — e.g. when the backend
// derives the id from `anonymous_id`. This lets `addUserExtraInfo` work without a prior user, like
// the mobile SDKs. The public `setUserInfo` still enforces an `id` (see the method below).
const USER_PROPERTIES: PropertiesConfig = {
  id: { type: 'string' },
  name: { type: 'string' },
  email: { type: 'string' },
};

export const USER_CONTEXT_HISTORY_FILE_NAME = '_dd_user_context_history';

/**
 * Stores user information and injects it as `usr` into RUM events and `meta.usr.*` into spans.
 */
export class UserContext extends ContextManager<UserInfo> {
  static async init(hooks: FormatHooks): Promise<UserContext> {
    const { initContextHistory } = await import('./contextHistory');
    const history = await initContextHistory(USER_CONTEXT_HISTORY_FILE_NAME);
    return new UserContext(hooks, history);
  }

  constructor(hooks: FormatHooks, history?: ContextHistory) {
    super('user', USER_PROPERTIES, history);
    hooks.registerRum(({ startTime }) => {
      const context = this.getContext(startTime);
      if (isEmptyObject(context)) return SKIPPED;
      return { usr: context };
    });
    hooks.registerSpan(({ startTime }) => {
      const context = this.getContext(startTime);
      if (isEmptyObject(context)) return SKIPPED;
      return { meta: toSpanMeta('usr', context) };
    });
  }

  /**
   * Sets the full user. An `id` is required here (unlike the underlying context store, which allows
   * id-less users): calls without one are ignored with a warning. To attach attributes to a user
   * whose `id` is derived elsewhere (e.g. from `anonymous_id`), use {@link addExtraInfo} instead.
   */
  setUserInfo(user: UserInfo): void {
    if (!user.id) {
      displayWarn(
        'setUserInfo: an "id" is required; the user will not be set. Use addUserExtraInfo to add attributes without an id.'
      );
      return;
    }
    this.setContext(user);
  }
}
