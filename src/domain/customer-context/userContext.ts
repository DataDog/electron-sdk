import { timeStampNow } from '@datadog/js-core/time';
import { ContextManager, type Context, type PropertiesConfig } from './contextManager';
import type { FormatHooks } from '../../assembly';
import type { ContextHistoryFactory } from '../tracking-consent';
import { SESSION_TIME_OUT_DELAY } from '../session';
import { registerContextHooks, type ContextHistory } from './registerContextHooks';
import { display } from '../../tools/display';

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
 * Stores user information and injects it as `usr` into RUM events and `usr.*` tags into spans.
 */
export class UserContext extends ContextManager<UserInfo> {
  static async init(hooks: FormatHooks, histories: ContextHistoryFactory): Promise<UserContext> {
    const history = await histories.create<Context>(USER_CONTEXT_HISTORY_FILE_NAME, SESSION_TIME_OUT_DELAY);
    return new UserContext(hooks, history);
  }

  constructor(hooks: FormatHooks, history: ContextHistory) {
    super('user', USER_PROPERTIES, (context) => history.set(context, timeStampNow()));
    registerContextHooks(hooks, history, () => this.getContext(), 'usr');
  }

  /**
   * Sets the full user. An `id` is required here (unlike the underlying context store, which allows
   * id-less users): calls without one are ignored with a warning. To attach attributes to a user
   * whose `id` is derived elsewhere (e.g. from `anonymous_id`), use {@link addExtraInfo} instead.
   */
  setUserInfo(user: UserInfo): void {
    if (!user.id) {
      display.warn(
        'setUserInfo: an "id" is required; the user will not be set. Use addUserExtraInfo to add attributes without an id.'
      );
      return;
    }
    this.setContext(user);
  }
}
