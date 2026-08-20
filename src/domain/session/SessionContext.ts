import { app } from 'electron';
import * as path from 'node:path';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import type { FormatHooks } from '../../assembly';
import { EventSource } from '../../event';
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
      if (sessionId !== undefined) return { session: { id: sessionId } };
      // Main-process telemetry is still worth sending without a session: an SDK error raised before the
      // first session, or in one that was sampled out, still reports a bug. A renderer event instead
      // arrives with the session id the browser SDK generates for itself in bridge mode — a stub nothing
      // else knows — and `combine` cannot remove a key, so drop the event rather than attribute telemetry
      // to a session Datadog never sees. Matches iOS, which drops webview telemetry for unsampled sessions.
      return params.source === EventSource.RENDERER ? DISCARDED : SKIPPED;
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

  // Returns the tracked session id covering the given time (defaults to now), or undefined if there is none.
  // A session is absent here when it had expired by then (entry closed) or was not sampled (never added),
  // so this is the single source of truth for "which tracked session covered this instant".
  getTrackedSessionId(at: TimeStamp = timeStampNow()): string | undefined {
    return this.history.find(at);
  }

  close(): void {
    this.history.closeActive(timeStampNow());
  }
}
