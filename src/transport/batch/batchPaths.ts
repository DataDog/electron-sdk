import type { LogSource } from '../../domain/logs';
import path from 'node:path';
import { EventTrack } from '../../event';

export const PENDING_DIRECTORY_PREFIX = 'pending-';
export const AUTHORIZED_PENDING_DIRECTORY_PREFIX = 'authorized-pending-';

/** The track root keeps authorized batches at their established location across SDK upgrades. */
export function getTrackPath(basePath: string, track: EventTrack, logsSource?: LogSource): string {
  if (track === EventTrack.LOGS && logsSource === 'electron') {
    return path.join(basePath, 'dd_main_logs');
  }
  return path.join(basePath, track === EventTrack.LOGS ? 'dd_logs' : track);
}
