import { SKIPPED } from '@datadog/js-core/assembly';
import type { TimeStamp } from '@datadog/js-core/time';
import { EventSource } from '../../event';
import type { FormatHooks } from '../../assembly';
import type { ViewReplayStats } from './ReplayCollection';

/**
 * Registers a RUM hook that injects session replay state into renderer view
 * events. Assembly triggers this hook like any other context hook, keeping
 * the replay-specific logic out of Assembly itself.
 */
export function registerReplayContext(
  hooks: FormatHooks,
  getViewReplayStats: (viewId: string) => ViewReplayStats | undefined,
  isReplayActiveAt: (at: TimeStamp) => boolean
): void {
  hooks.registerRum(({ source, eventType, startTime, rendererViewId }) => {
    if (source !== EventSource.RENDERER || eventType !== 'view' || !rendererViewId) {
      return SKIPPED;
    }

    // has_replay reflects the main process's replay SAMPLING decision — mirroring the Browser SDK,
    // where it means "replay is being recorded for this session" — not whether a segment has flushed
    // yet. It is resolved for the event's *own* session (by startTime), like the session and
    // profiling hooks, so a view event delivered after an expiry/renewal isn't stamped with the
    // current session's decision. The main process is authoritative (it samples and uploads), so we
    // always override the renderer's values. This avoids three failure modes:
    //  - false positive: the renderer stamped has_replay but Electron sampled that session out;
    //  - false negative: a segment is buffered but not yet flushed (short views / route changes)
    //    when the view event is sent, which a flush-state-based flag would wrongly report as no replay;
    //  - wrong-session: a late view event getting the current session's decision instead of its own.
    if (!isReplayActiveAt(startTime)) {
      // No replay for this session. Zero every replay_stats field (rather than omit) because
      // combine() merges key-by-key and skips undefined, so omitting would let stale renderer counts
      // survive onto a view that claims no replay.
      return {
        session: { has_replay: false },
        _dd: {
          replay_stats: {
            records_count: 0,
            segments_count: 0,
            segments_total_raw_size: 0,
          },
        },
      };
    }

    // Replay is active. Report the main process's authoritative segment counts (0 until the first
    // flush for this view). records_count is left untouched: the SDK does not track it per view, and
    // the renderer's own count is the best available.
    const stats = getViewReplayStats(rendererViewId);
    return {
      session: { has_replay: true },
      _dd: {
        replay_stats: {
          segments_count: stats?.segments_count ?? 0,
          segments_total_raw_size: stats?.segments_total_raw_size ?? 0,
        },
      },
    };
  });
}
