import { app } from 'electron';
import * as path from 'node:path';
import { isEmptyObject } from '@datadog/browser-core';
import { SKIPPED } from '@datadog/js-core/assembly';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { isIndexableObject } from '@datadog/js-core/util';
import type { FormatHooks, RumEventType } from '../../assembly';
import type { FeatureFlagsForEvents } from '../../config';
import { EventSource } from '../../event';
import { DiskValueHistory } from '../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../session';

export const FEATURE_FLAG_HISTORY_FILE_NAME = '_dd_feature_flag_history';

/** Stores main-view flag evaluations, retaining past views on disk for recovered crash attribution. */
export class FeatureFlagContext {
  private constructor(
    hooks: FormatHooks,
    private readonly history: DiskValueHistory<Record<string, unknown>>,
    trackFeatureFlagsForEvents: readonly FeatureFlagsForEvents[]
  ) {
    // Follow Browser RUM's per-view context, rather than creating a history entry per evaluation:
    // https://github.com/DataDog/browser-sdk/blob/main/packages/browser-rum-core/src/domain/contexts/featureFlagContext.ts
    const trackedEventTypes: readonly RumEventType[] = ['view', 'error', ...trackFeatureFlagsForEvents];
    hooks.registerRum(({ source, eventType, startTime }) => {
      if (source !== EventSource.MAIN || !trackedEventTypes.includes(eventType)) return SKIPPED;
      const flags = history.find(startTime);
      if (!isIndexableObject(flags) || isEmptyObject(flags)) return SKIPPED;
      return { feature_flags: flags };
    });
  }

  static async init(
    hooks: FormatHooks,
    trackFeatureFlagsForEvents: readonly FeatureFlagsForEvents[] = []
  ): Promise<FeatureFlagContext> {
    const history = await DiskValueHistory.init<Record<string, unknown>>({
      filePath: path.join(app.getPath('userData'), FEATURE_FLAG_HISTORY_FILE_NAME),
      expireDelay: SESSION_TIME_OUT_DELAY,
    });
    history.closeActive(timeStampNow());
    return new FeatureFlagContext(hooks, history, trackFeatureFlagsForEvents);
  }

  startView(startTime: TimeStamp): void {
    this.history.closeAndAdd({}, startTime);
  }

  closeView(endTime: TimeStamp): void {
    this.history.closeActive(endTime);
  }

  /** Returns whether an active view accepted the evaluation. */
  addEvaluation(key: string, value: unknown): boolean {
    const flags = this.history.find(timeStampNow());
    if (!flags) return false;
    this.history.updateActive({ ...flags, [key]: value });
    return true;
  }
}
