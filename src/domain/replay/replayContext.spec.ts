import { describe, it, expect, vi } from 'vitest';
import type { TimeStamp } from '@datadog/browser-core';
import { createFormatHooks } from '../../assembly';
import { EventSource } from '../../event';
import type { ViewReplayStats } from './ReplayCollection';
import { registerReplayContext } from './replayContext';

const STATS: ViewReplayStats = { segments_count: 3, segments_total_raw_size: 1024 };

describe('registerReplayContext', () => {
  describe('when to skip', () => {
    it('returns SKIPPED for main-process events', () => {
      const hooks = createFormatHooks();
      const getStats = vi.fn().mockReturnValue(STATS);
      registerReplayContext(hooks, getStats);

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
      registerReplayContext(hooks, getStats);

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
      registerReplayContext(hooks, getStats);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
      });

      expect(getStats).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('returns SKIPPED when no replay stats exist for the view', () => {
      const hooks = createFormatHooks();
      registerReplayContext(hooks, () => undefined);

      const result = hooks.triggerRum({
        eventType: 'view',
        startTime: 0 as TimeStamp,
        source: EventSource.RENDERER,
        rendererViewId: 'view-no-stats',
      });

      expect(result).toBeUndefined();
    });
  });

  describe('when replay stats exist for a renderer view event', () => {
    it('calls getViewReplayStats with the renderer view ID', () => {
      const hooks = createFormatHooks();
      const getStats = vi.fn().mockReturnValue(STATS);
      registerReplayContext(hooks, getStats);

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
      registerReplayContext(hooks, () => STATS);

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
      registerReplayContext(hooks, () => STATS);

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
  });

  describe('integration with other hooks', () => {
    it('combines replay attributes with other registered hook results', () => {
      const hooks = createFormatHooks();
      hooks.registerRum(() => ({ session: { id: 'main-session-id' } }));
      registerReplayContext(hooks, () => STATS);

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
      registerReplayContext(hooks, () => STATS);

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
