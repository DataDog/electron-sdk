import { app } from 'electron';
import * as path from 'node:path';
import { timeStampNow } from '@datadog/js-core/time';
import { DiskValueHistory } from '../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../session';
import type { Context, ContextHistory } from './contextManager';

/**
 * Creates a crash-attribution history for customer context.
 *
 * The active entry from the previous process is closed during SDK startup so it can still enrich
 * crash events that happened before relaunch, without leaking that context into new events.
 */
export async function initContextHistory(fileName: string): Promise<ContextHistory> {
  const filePath = path.join(app.getPath('userData'), fileName);
  const history = await DiskValueHistory.init<Context>({ filePath, expireDelay: SESSION_TIME_OUT_DELAY });
  history.closeActive(timeStampNow());
  return history;
}
