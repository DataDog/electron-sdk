import { SKIPPED } from '@datadog/browser-core';
import { EventSource } from '../../event';
import type { FormatHooks } from '../../assembly';
import type { ViewReplayStats } from './ReplayCollection';

/**
 * Registers a RUM hook that injects session replay stats into renderer view
 * events. Assembly triggers this hook like any other context hook, keeping
 * the replay-specific logic out of Assembly itself.
 */
export function registerReplayContext(
  hooks: FormatHooks,
  getViewReplayStats: (viewId: string) => ViewReplayStats | undefined
): void {
  hooks.registerRum(({ source, eventType, rendererViewId }) => {
    if (source !== EventSource.RENDERER || eventType !== 'view' || !rendererViewId) {
      return SKIPPED;
    }

    const stats = getViewReplayStats(rendererViewId);
    if (!stats) {
      return SKIPPED;
    }

    return {
      session: { has_replay: true } as object,
      _dd: {
        replay_stats: {
          segments_count: stats.segments_count,
          segments_total_raw_size: stats.segments_total_raw_size,
        },
      },
    };
  });
}
