import { app } from 'electron';
import * as path from 'node:path';
import { TrackingConsentHistory, type TrackingConsentManager } from '../tracking-consent';
import { SESSION_TIME_OUT_DELAY } from '../session';
import type { Context, ContextHistory } from './contextManager';

/**
 * Creates a crash-attribution history for customer context.
 *
 * The active entry from the previous process is closed during SDK startup so it can still enrich
 * crash events that happened before relaunch, without leaking that context into new events.
 */
export async function initContextHistory(
  fileName: string,
  trackingConsentManager: TrackingConsentManager
): Promise<ContextHistory> {
  const filePath = path.join(app.getPath('userData'), fileName);
  return TrackingConsentHistory.init<Context>(
    { filePath, expireDelay: SESSION_TIME_OUT_DELAY },
    trackingConsentManager
  );
}
