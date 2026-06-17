import { app } from 'electron';
import * as path from 'node:path';
import { timeStampNow } from '@datadog/js-core/time';
import { DISCARDED, SKIPPED } from '@datadog/browser-core';
import type { FormatHooks } from '../../assembly';
import { DiskValueHistory } from '../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from './session.constants';

export const SESSION_HISTORY_FILE_NAME = '_dd_session_history';

// Disk format introduced with sessionSampleRate support.
// Previous format stored a plain string (session ID only) — see migrateSessionEntry below.
interface SessionEntry {
  id: string;
  isSampled: boolean;
}

// Migration from the pre-sessionSampleRate disk format (value was a plain session ID string).
// Old entries are treated as sampled to preserve crash attribution for sessions recorded
// before this feature was introduced.
function isValidSessionEntry(raw: unknown): raw is SessionEntry {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as SessionEntry).id === 'string' &&
    typeof (raw as SessionEntry).isSampled === 'boolean'
  );
}

function migrateSessionEntry(raw: unknown): SessionEntry {
  if (typeof raw === 'string') {
    return { id: raw, isSampled: true };
  }
  if (isValidSessionEntry(raw)) {
    return raw;
  }
  // Unknown shape — discard to avoid emitting RUM with a corrupt session ID
  return { id: '', isSampled: false };
}

export class SessionContext {
  private readonly history: DiskValueHistory<SessionEntry>;

  private constructor(history: DiskValueHistory<SessionEntry>, hooks: FormatHooks) {
    this.history = history;

    hooks.registerRum((params) => {
      const entry = this.history.find(params.startTime);
      if (entry === undefined) return DISCARDED;
      if (!entry.isSampled) return DISCARDED;
      return { session: { id: entry.id } };
    });

    hooks.registerTelemetry((params) => {
      const entry = this.history.find(params.startTime);
      if (entry === undefined) return SKIPPED;
      return { session: { id: entry.id } };
    });

    hooks.registerSpan((params) => {
      const entry = this.history.find(params.startTime);
      if (entry === undefined) return DISCARDED;
      return { meta: { '_dd.session.id': entry.id } };
    });
  }

  static async init(hooks: FormatHooks, expireDelay = SESSION_TIME_OUT_DELAY): Promise<SessionContext> {
    const filePath = path.join(app.getPath('userData'), SESSION_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<SessionEntry>({
      filePath,
      expireDelay,
      migrateValue: migrateSessionEntry,
    });
    return new SessionContext(history, hooks);
  }

  add(sessionId: string, isSampled: boolean): void {
    this.history.add({ id: sessionId, isSampled }, timeStampNow());
  }

  close(): void {
    this.history.closeActive(timeStampNow());
  }
}
