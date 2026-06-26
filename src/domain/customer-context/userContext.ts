import { SKIPPED } from '@datadog/js-core/assembly';
import { ContextManager, type PropertiesConfig } from './contextManager';
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

/**
 * Stores user information and injects it as `usr` into RUM events via format hooks.
 */
export class UserContext extends ContextManager<UserInfo> {
  constructor(hooks: FormatHooks) {
    super('user', USER_PROPERTIES);
    hooks.registerRum(() => {
      if (this.isEmpty()) return SKIPPED;
      return { usr: this.getContext() };
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
