import { app } from 'electron';
import * as path from 'node:path';
import { timeStampNow } from '@datadog/js-core/time';
import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import type { FormatHooks } from '../../assembly';
import { DiskValueHistory } from '../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from './session.constants';

export const SESSION_HISTORY_FILE_NAME = '_dd_session_history';

export class SessionContext {
  private readonly history: DiskValueHistory<string>;

  private constructor(history: DiskValueHistory<string>, hooks: FormatHooks) {
    this.history = history;

    hooks.registerRum((params) => {
      const sessionId = this.history.find(params.startTime);
      if (sessionId === undefined) return DISCARDED;
      return { session: { id: sessionId } };
    });

    hooks.registerTelemetry((params) => {
      const sessionId = this.history.find(params.startTime);
      if (sessionId === undefined) return SKIPPED;
      return { session: { id: sessionId } };
    });

    hooks.registerSpan((params) => {
      const sessionId = this.history.find(params.startTime);
      if (sessionId === undefined) return DISCARDED;
      return { meta: { '_dd.session.id': sessionId } };
    });
  }

  static async init(hooks: FormatHooks, expireDelay = SESSION_TIME_OUT_DELAY): Promise<SessionContext> {
    const filePath = path.join(app.getPath('userData'), SESSION_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<string>({ filePath, expireDelay });
    return new SessionContext(history, hooks);
  }

  add(sessionId: string): void {
    this.history.add(sessionId, timeStampNow());
  }

  // Returns the tracked session id at the current time, or undefined if there is none.
  // A session is absent here when it has expired (entry closed) or was not sampled (never added),
  // so this is the single source of truth for "is there a tracked session right now".
  getActiveSessionId(): string | undefined {
    return this.history.find(timeStampNow());
  }

  close(): void {
    this.history.closeActive(timeStampNow());
  }
}
