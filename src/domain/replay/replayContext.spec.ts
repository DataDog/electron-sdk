import { describe, it, expect, vi } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { createFormatHooks } from '../../assembly';
import { EventSource } from '../../event';
import type { ViewReplayStats } from './ReplayCollection';
import { registerReplayContext } from './replayContext';

const STATS: ViewReplayStats = { segments_count: 3, segments_total_raw_size: 1024 };
const ACTIVE = () => true;
const INACTIVE = () => false;

describe('registerReplayContext', () => {
  describe('when to skip', () => {
    it('returns SKIPPED for main-process events', () => {
      const hooks = createFormatHooks();
      const getStats = vi.fn().mockReturnValue(STATS);
      registerReplayContext(hooks, getStats, ACTIVE);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.MAIN,
        rendererViewId: 'view-1',
      });

      expect(getStats).not.toHaveBeenCalled();
      // result is undefined (SKIPPED by our hook, no other hooks registered)
      expect(result).toBeUndefined();
    });

    it('returns SKIPPED for renderer non-view events', () => {
      const hooks = createFormatHooks();
      const getStats = vi.fn().mockReturnValue(STATS);
      registerReplayContext(hooks, getStats, ACTIVE);

      const result = hooks.triggerRum({
        eventType: 'error',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-1',
      });

      expect(getStats).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('returns SKIPPED when rendererViewId is missing', () => {
      const hooks = createFormatHooks();
      const getStats = vi.fn().mockReturnValue(STATS);
      registerReplayContext(hooks, getStats, ACTIVE);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
      });

      expect(getStats).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe('when replay is not active (session sampled out)', () => {
    it('clears has_replay and zeroes replay_stats, regardless of any buffered stats', () => {
      const hooks = createFormatHooks();
      // Even if stats somehow exist, an inactive session must report no replay.
      registerReplayContext(hooks, () => STATS, INACTIVE);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-1',
      });

      // The session was not sampled for replay, so the RUM view must not claim a replay exists —
      // nor carry stale renderer-provided stats — even if the renderer stamped them.
      expect((result as Record<string, unknown>)?.['session']).toMatchObject({ has_replay: false });
      expect((result as Record<string, unknown>)?.['_dd']).toMatchObject({
        replay_stats: { records_count: 0, segments_count: 0, segments_total_raw_size: 0 },
      });
    });
  });

  describe('when replay is active for a renderer view event', () => {
    it('calls getViewReplayStats with the renderer view ID', () => {
      const hooks = createFormatHooks();
      const getStats = vi.fn().mockReturnValue(STATS);
      registerReplayContext(hooks, getStats, ACTIVE);

      hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-abc',
      });

      expect(getStats).toHaveBeenCalledWith('view-abc');
    });

    it('returns session.has_replay: true', () => {
      const hooks = createFormatHooks();
      registerReplayContext(hooks, () => STATS, ACTIVE);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-1',
      });

      expect((result as Record<string, unknown>)?.['session']).toMatchObject({ has_replay: true });
    });

    it('returns _dd.replay_stats with segments_count and segments_total_raw_size', () => {
      const hooks = createFormatHooks();
      registerReplayContext(hooks, () => STATS, ACTIVE);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-1',
      });

      expect((result as Record<string, unknown>)?.['_dd']).toMatchObject({
        replay_stats: {
          segments_count: STATS.segments_count,
          segments_total_raw_size: STATS.segments_total_raw_size,
        },
      });
    });

    it('reports has_replay: true with zeroed segment counts before the first segment is flushed', () => {
      const hooks = createFormatHooks();
      // Active session, but no segment flushed yet for this view (short view / route change).
      registerReplayContext(hooks, () => undefined, ACTIVE);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-buffered',
      });

      // A segment is buffered and will be uploaded, so the view must still claim a replay exists.
      expect((result as Record<string, unknown>)?.['session']).toMatchObject({ has_replay: true });
      expect((result as Record<string, unknown>)?.['_dd']).toMatchObject({
        replay_stats: { segments_count: 0, segments_total_raw_size: 0 },
      });
    });
  });

  describe('attribution by event start time', () => {
    it('resolves has_replay for the event start time, not the current session', () => {
      const hooks = createFormatHooks();
      // Replay is active only for events at/after t=1000 (e.g. an older event's session was sampled
      // out or had expired). A late-delivered view event must be judged by its own startTime.
      const isReplayActiveAt = (at: TimeStamp) => (at as number) >= 1000;
      registerReplayContext(hooks, () => STATS, isReplayActiveAt);

      const oldView = hooks.triggerRum({
        eventType: 'view',
        startTime: 500 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-old',
      });
      const newView = hooks.triggerRum({
        eventType: 'view',
        startTime: 1500 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-new',
      });

      expect((oldView as Record<string, unknown>)?.['session']).toMatchObject({ has_replay: false });
      expect((newView as Record<string, unknown>)?.['session']).toMatchObject({ has_replay: true });
    });
  });

  describe('integration with other hooks', () => {
    it('combines replay attributes with other registered hook results', () => {
      const hooks = createFormatHooks();
      hooks.registerRum(() => ({ session: { id: 'main-session-id' } }));
      registerReplayContext(hooks, () => STATS, ACTIVE);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-1',
      });

      const session = (result as Record<string, unknown>)?.['session'] as Record<string, unknown>;
      expect(session?.['id']).toBe('main-session-id');
      expect(session?.['has_replay']).toBe(true);
    });

    it('does not interfere with non-replay hooks for main-process events', () => {
      const hooks = createFormatHooks();
      hooks.registerRum(() => ({ session: { id: 'main-session-id' } }));
      registerReplayContext(hooks, () => STATS, ACTIVE);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.MAIN,
      });

      const session = (result as Record<string, unknown>)?.['session'] as Record<string, unknown>;
      expect(session?.['id']).toBe('main-session-id');
      expect(session?.['has_replay']).toBeUndefined();
    });
  });
});
