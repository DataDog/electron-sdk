import { mockFs } from '../../../mocks.specUtil';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webContents: {
    getAllWebContents: vi.fn(() => []),
  },
}));

vi.mock('../../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app, webContents } from 'electron';
import { RendererProcessContexts } from './RendererProcessContexts';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';
import { EventManager, EventKind, EventFormat, EventSource, LifecycleKind, type RawRumEvent } from '../../../event';
import { createFormatHooks } from '../../../assembly';
import type { RawRumExecutionContext } from '../types';

vi.mock('node:fs/promises');
const mfs = mockFs();

describe('RendererProcessContexts', () => {
  let eventManager: EventManager;
  let hooks: ReturnType<typeof createFormatHooks>;
  let rawRumEvents: RawRumEvent[];
  let collection: RendererProcessContexts;
  let webContentsCreatedHandler: (event: unknown, webContents: unknown) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);

    eventManager = new EventManager();
    hooks = createFormatHooks();
    rawRumEvents = [];
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (e): e is RawRumEvent => e.kind === EventKind.RAW && e.format === EventFormat.RUM,
      handle: (e) => rawRumEvents.push(e),
    });
    vi.mocked(app).on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'web-contents-created') {
        webContentsCreatedHandler = handler;
      }
      return app;
    });

    collection = RendererProcessContexts.start(eventManager, hooks);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  describe('renderer processes', () => {
    function makeWebContents(id: number) {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      return {
        id,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          (listeners[event] ??= []).push(handler);
        }),
        once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          const wrapper = (...args: unknown[]) => {
            listeners[event] = listeners[event].filter((h) => h !== wrapper);
            handler(...args);
          };
          // Node's real EventEmitter lets removeListener(event, originalHandler) remove a listener
          // registered via once(), by tracking the original on the wrapper it actually stores —
          // mirrored here so removeListener works the same way against this mock.
          wrapper.listener = handler;
          (listeners[event] ??= []).push(wrapper);
        }),
        removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          listeners[event] = (listeners[event] ?? []).filter(
            (h) => h !== handler && (h as { listener?: unknown }).listener !== handler
          );
        }),
        _emit: (event: string, ...args: unknown[]) => listeners[event]?.slice().forEach((h) => h(...args)),
        _listenerCount: (event: string) => listeners[event]?.length ?? 0,
      };
    }

    it('emits a start event when web-contents-created fires', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      expect(rawRumEvents).toHaveLength(base + 1);
      const rendererStart = rawRumEvents[base].data as RawRumExecutionContext;
      expect(rendererStart.execution_context.type).toBe('renderer-process');
      expect(rendererStart.execution_context.instance_id).toBe('1');
      expect(rendererStart._dd.document_version).toBe(1);
    });

    it('backfills execution contexts for webContents that already exist at start', () => {
      const existing = makeWebContents(9);
      vi.mocked(webContents).getAllWebContents.mockReturnValueOnce([existing as unknown as Electron.WebContents]);

      const freshEventManager = new EventManager();
      const freshHooks = createFormatHooks();
      const freshEvents: RawRumEvent[] = [];
      freshEventManager.registerHandler<RawRumEvent>({
        canHandle: (e): e is RawRumEvent => e.kind === EventKind.RAW && e.format === EventFormat.RUM,
        handle: (e) => freshEvents.push(e),
      });

      RendererProcessContexts.start(freshEventManager, freshHooks);

      expect(freshEvents).toHaveLength(1);
      const started = freshEvents[0].data as RawRumExecutionContext;
      expect(started.execution_context.type).toBe('renderer-process');
      expect(started.execution_context.instance_id).toBe('9');

      expect(
        freshHooks.triggerRum({
          eventType: 'view',
          startTime: 0 as never,
          source: EventSource.RENDERER,
          webContentsId: 9,
        })
      ).toMatchObject({ execution_context: { id: started.execution_context.id, type: 'renderer-process' } });
    });

    it('tags subsequent RENDERER events with the matching execution context', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const rendererId = (rawRumEvents[base].data as RawRumExecutionContext).execution_context.id;

      expect(
        hooks.triggerRum({ eventType: 'view', startTime: 0 as never, source: EventSource.RENDERER, webContentsId: 1 })
      ).toMatchObject({ execution_context: { id: rendererId, type: 'renderer-process' } });
    });

    it('emits an end event and stops tagging the renderer on destroyed', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1) as unknown as {
        id: number;
        _emit: (event: string, ...args: unknown[]) => void;
      };
      webContentsCreatedHandler({}, wc);
      wc._emit('destroyed');

      expect(rawRumEvents).toHaveLength(base + 2); // renderer start + renderer end
      const rendererEnd = rawRumEvents[base + 1].data as RawRumExecutionContext;
      expect(rendererEnd._dd.document_version).toBe(2);
      expect(rendererEnd.execution_context.exit_reason).toBe('clean-exit');

      expect(
        (
          hooks.triggerRum({
            eventType: 'view',
            startTime: 0 as never,
            source: EventSource.RENDERER,
            webContentsId: 1,
          }) as { execution_context?: unknown } | undefined
        )?.execution_context
      ).toBeUndefined();
    });

    it('carries the exit reason on render-process-gone', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1) as unknown as {
        id: number;
        _emit: (event: string, ...args: unknown[]) => void;
      };
      webContentsCreatedHandler({}, wc);
      wc._emit('render-process-gone', {}, { reason: 'crashed' });

      const rendererEnd = rawRumEvents[base + 1].data as RawRumExecutionContext;
      expect(rendererEnd.execution_context.exit_reason).toBe('crashed');
    });

    it('re-registers a fresh execution context once the same webContents reloads after render-process-gone', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const firstId = (rawRumEvents[base].data as RawRumExecutionContext).execution_context.id;

      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      expect(
        (
          hooks.triggerRum({
            eventType: 'view',
            startTime: 0 as never,
            source: EventSource.RENDERER,
            webContentsId: 1,
          }) as { execution_context?: unknown } | undefined
        )?.execution_context
      ).toBeUndefined();

      // Electron reuses the same webContents object across the crash: 'web-contents-created' never
      // fires again, so the app's reload is only observable as 'did-start-navigation' on that
      // reference.
      wc._emit('did-start-navigation', { isMainFrame: true });

      const revived = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(revived.execution_context.type).toBe('renderer-process');
      expect(revived.execution_context.id).not.toBe(firstId);
      expect(revived._dd.document_version).toBe(1);
      expect(
        hooks.triggerRum({ eventType: 'view', startTime: 0 as never, source: EventSource.RENDERER, webContentsId: 1 })
      ).toMatchObject({ execution_context: { id: revived.execution_context.id, type: 'renderer-process' } });
    });

    it('a revived webContents ending for real does not double-emit from the pre-crash listeners', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);

      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      wc._emit('did-start-navigation', { isMainFrame: true });
      const countAfterRevival = rawRumEvents.length;

      // The pre-crash 'destroyed'/'render-process-gone' listeners must have been removed on
      // revival, leaving exactly the fresh registration's pair — not a growing accumulation.
      expect(wc._listenerCount('destroyed')).toBe(1);
      expect(wc._listenerCount('render-process-gone')).toBe(1);

      wc._emit('destroyed');

      expect(rawRumEvents).toHaveLength(countAfterRevival + 1); // exactly one end event, not two
    });

    it('a second crash before the first pending reload finishes replaces it, instead of both firing on the next load', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);

      // First crash: attaches a pending 'did-start-navigation' revival callback.
      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      expect(wc._listenerCount('did-start-navigation')).toBe(1);

      // The replacement renderer crashes again before its own navigation ever started — the stale
      // pending callback from the first crash must be dropped, not stacked alongside a new one.
      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      expect(wc._listenerCount('did-start-navigation')).toBe(1);

      wc._emit('did-start-navigation', { isMainFrame: true });

      const revivedEvents = rawRumEvents
        .slice(base)
        .filter((e) => (e.data as RawRumExecutionContext).execution_context.type === 'renderer-process');
      const starts = revivedEvents.filter((e) => (e.data as RawRumExecutionContext)._dd.document_version === 1);
      expect(starts).toHaveLength(2); // the original start, plus exactly one revival start — not two

      // Only one heartbeat timer should be ticking — the orphaned one from a double-fired revival
      // would tick too and inflate this count.
      rawRumEvents.length = 0;
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      expect(rawRumEvents).toHaveLength(1);
    });

    it('stop() clears a renderer heartbeat timer too', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const countAfterStart = rawRumEvents.length;

      collection.stop();
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL * 3);
      expect(rawRumEvents).toHaveLength(countAfterStart);
    });

    it('stop() detaches every per-webContents listener, including a pending crash-revival one', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      expect(wc._listenerCount('destroyed')).toBeGreaterThan(0);
      expect(wc._listenerCount('render-process-gone')).toBeGreaterThan(0);
      expect(wc._listenerCount('did-start-navigation')).toBeGreaterThan(0);

      collection.stop();

      expect(wc._listenerCount('destroyed')).toBe(0);
      expect(wc._listenerCount('render-process-gone')).toBe(0);
      expect(wc._listenerCount('did-start-navigation')).toBe(0);

      // A navigation starting after stop() must not resurrect tracking (no new event, no new timer).
      const countAfterStop = rawRumEvents.length;
      wc._emit('did-start-navigation', { isMainFrame: true });
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL * 3);
      expect(rawRumEvents).toHaveLength(countAfterStop);
    });

    it('closes the renderer context on SESSION_EXPIRED without deleting or tagging an exit_reason', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const rendererId = (rawRumEvents[base].data as RawRumExecutionContext).execution_context.id;

      // Advance so the close's endTime is strictly after the context's own startTime — otherwise
      // the half-open history interval closes at the exact same instant it started, and the lookup
      // below (at that original startTime) would land right on the excluded boundary.
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL / 2);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      const closeEvent = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(closeEvent.execution_context.id).toBe(rendererId);
      expect(closeEvent.execution_context.exit_reason).toBeUndefined();
      expect(closeEvent._dd.document_version).toBe(2);

      // Still tagged (not deleted) — only a real destroy event removes the tagging entry.
      expect(
        hooks.triggerRum({ eventType: 'view', startTime: 0 as never, source: EventSource.RENDERER, webContentsId: 1 })
      ).toMatchObject({ execution_context: { id: rendererId, type: 'renderer-process' } });
    });

    it('resolves a renderer event by its own startTime, not current state, so one delivered after a SESSION_RENEW but timestamped before the boundary still resolves to the pre-renewal context', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const originalEvent = rawRumEvents[rawRumEvents.length - 1];
      const originalStartTime = originalEvent.startTime!;
      const originalId = (originalEvent.data as RawRumExecutionContext).execution_context.id;

      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL / 2);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL / 2);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const renewedEvent = rawRumEvents[rawRumEvents.length - 1];
      const renewedStartTime = renewedEvent.startTime!;
      const renewedId = (renewedEvent.data as RawRumExecutionContext).execution_context.id;
      expect(renewedId).not.toBe(originalId);

      expect(
        hooks.triggerRum({
          eventType: 'view',
          startTime: originalStartTime,
          source: EventSource.RENDERER,
          webContentsId: 1,
        })
      ).toMatchObject({ execution_context: { id: originalId } });
      expect(
        hooks.triggerRum({
          eventType: 'view',
          startTime: renewedStartTime,
          source: EventSource.RENDERER,
          webContentsId: 1,
        })
      ).toMatchObject({ execution_context: { id: renewedId } });
    });

    it('a destroy during the sessionless gap stops tagging but does not mutate the already-closed context', () => {
      const wc = makeWebContents(1) as unknown as {
        id: number;
        _emit: (event: string, ...args: unknown[]) => void;
      };
      webContentsCreatedHandler({}, wc);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      const closeEvent = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      const countAfterClose = rawRumEvents.length;

      wc._emit('destroyed');

      // The real destroy must not emit a mutated version of the already-closed record — no new
      // event, and the session-boundary close event itself is untouched.
      expect(rawRumEvents).toHaveLength(countAfterClose);
      expect(closeEvent._dd.document_version).toBe(2);
      expect(closeEvent.execution_context.exit_reason).toBeUndefined();

      // Tagging has stopped now that the webContents is truly gone.
      expect(
        (
          hooks.triggerRum({
            eventType: 'view',
            startTime: 0 as never,
            source: EventSource.RENDERER,
            webContentsId: 1,
          }) as { execution_context?: unknown } | undefined
        )?.execution_context
      ).toBeUndefined();
    });

    it('reopens a new renderer context on SESSION_RENEW with a new id but the same instance_id', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const oldId = (rawRumEvents[base].data as RawRumExecutionContext).execution_context.id;

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const newContext = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(newContext.execution_context.id).not.toBe(oldId);
      expect(newContext.execution_context.instance_id).toBe('1');
      expect(newContext._dd.document_version).toBe(1);

      expect(
        hooks.triggerRum({ eventType: 'view', startTime: 0 as never, source: EventSource.RENDERER, webContentsId: 1 })
      ).toMatchObject({ execution_context: { id: newContext.execution_context.id, type: 'renderer-process' } });
    });

    it('the new renderer context keeps ticking on its own heartbeat after renewal', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      rawRumEvents.length = 0;

      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);

      const rendererHeartbeat = rawRumEvents.find(
        (e) => (e.data as RawRumExecutionContext).execution_context.type === 'renderer-process'
      )!.data as RawRumExecutionContext;
      expect(rendererHeartbeat._dd.document_version).toBe(2);
    });

    it('a renderer created after a renewal starts fresh with no rotation history', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      const countBeforeCreate = rawRumEvents.length;

      const wc = makeWebContents(2);
      webContentsCreatedHandler({}, wc);

      const started = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(rawRumEvents).toHaveLength(countBeforeCreate + 1);
      expect(started._dd.document_version).toBe(1);
      expect(started.execution_context.instance_id).toBe('2');
    });

    it('does not leak an orphaned heartbeat when a renderer registered during the sessionless gap is renewed', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      // Registered while the session is already expired: never goes through
      // closeAllRenderersForSessionExpiry, so its heartbeat starts ticking immediately.
      const wc = makeWebContents(3);
      webContentsCreatedHandler({}, wc);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      rawRumEvents.length = 0;

      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);

      // Exactly one heartbeat, not two — the pre-renewal timer must have been cleared instead of
      // being orphaned alongside the fresh one renewal starts.
      const heartbeats = rawRumEvents.filter(
        (e) => (e.data as RawRumExecutionContext).execution_context.type === 'renderer-process'
      );
      expect(heartbeats).toHaveLength(1);
    });

    it('closes the renderer context on SESSION_EXPIRED at its own pinned startTime, not a fresh now() read', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const rendererStartEvent = rawRumEvents[base];
      const rendererId = (rendererStartEvent.data as RawRumExecutionContext).execution_context.id;
      const originalStartTime = rendererStartEvent.startTime;

      // Advance the clock without reaching PROCESS_UPDATE_INTERVAL, so only the elapsed "now" moves
      // and no heartbeat fires in between.
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL / 2);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      const closeEvent = rawRumEvents.find(
        (e) =>
          e !== rendererStartEvent && e.data.type === 'execution_context' && e.data.execution_context.id === rendererId
      )!;
      expect(closeEvent.startTime).toBe(originalStartTime);
    });
  });
});
