import { app } from 'electron';
import * as path from 'node:path';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
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

    hooks.registerLogs((params) => {
      const sessionId = this.history.find(params.startTime);
      // A log without a session is worth sending for a reason of its own: it reports on the customer's
      // app, not on the SDK, and Logs is a product a customer pays for whether or not RUM sampled the
      // session. Both mobile SDKs draw the same line — Android attaches the RUM ids only
      // `if (rumContext != null)`, iOS only `if let rum = ...`.
      //
      // The id is nulled rather than left alone when there is none, as in the telemetry hook above: a
      // renderer log arrives carrying the session id the browser SDK generates for itself in bridge mode,
      // a stub nothing else knows, and `combine` cannot remove a key. `null` is equivalent to absent for
      // the backend, the same device used for `_dd.profiling`.
      const id = sessionId ?? null;
      return { session_id: id, session: { id } };
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
