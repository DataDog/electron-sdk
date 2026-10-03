import { createTestConfiguration, mockFs } from '../../../mocks.specUtil';

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
import { RendererProcessContexts, RENDERER_DISPOSAL_GRACE_PERIOD } from './RendererProcessContexts';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';
import {
  EventManager,
  EventKind,
  EventFormat,
  EventSource,
  LifecycleKind,
  type RawRumEvent,
  type ServerEvent,
} from '../../../event';
import { BeforeSend, createFormatHooks, MainAssembly } from '../../../assembly';
import type { RawRumExecutionContext } from '../types';
import { ContextHistoryFactory, TrackingConsentManager } from '../../tracking-consent';
import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import { DISCARDED } from '@datadog/js-core/assembly';
import { SessionManager } from '../../session';

vi.mock('node:fs/promises');
const mfs = mockFs();

describe('RendererProcessContexts', () => {
  let eventManager: EventManager;
  let hooks: ReturnType<typeof createFormatHooks>;
  let rawRumEvents: RawRumEvent[];
  let collection: RendererProcessContexts;
  let sessionManager: SessionManager | undefined;
  let histories: ContextHistoryFactory | undefined;
  let consentManager: TrackingConsentManager;
  let webContentsCreatedHandler: (event: unknown, webContents: unknown) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    consentManager = new TrackingConsentManager();
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

    collection = RendererProcessContexts.start(eventManager, hooks, consentManager);
  });

  afterEach(() => {
    collection.stop();
    sessionManager?.stop();
    sessionManager = undefined;
    histories?.stop();
    histories = undefined;
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
        getURL: vi.fn(() => ''),
        isDestroyed: vi.fn(() => false),
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
      expect(rawRumEvents[base]).not.toHaveProperty('storageConsent');
    });

    it.each(['pending', 'granted'] as const)('splits renderer durations when consent becomes %s', (next) => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      if (next === 'granted') consentManager.update('pending');
      const previous = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      rawRumEvents.length = 0;
      vi.advanceTimersByTime(10);

      consentManager.update(next);

      expect(rawRumEvents).toHaveLength(2);
      expect(rawRumEvents[0].data).toMatchObject({
        execution_context: { id: previous.execution_context.id, duration: 10e6 },
      });
      if (next === 'pending') {
        expect(rawRumEvents[0]).toMatchObject({ storageConsent: 'granted' });
      } else {
        expect(rawRumEvents[0]).not.toHaveProperty('storageConsent');
      }
      const started = rawRumEvents[1].data as RawRumExecutionContext;
      expect(started.execution_context.id).not.toBe(previous.execution_context.id);
      expect(started.execution_context.instance_id).toBe('1');
      expect(started.execution_context.duration).toBe(0);
      expect(started._dd.document_version).toBe(1);
      rawRumEvents.length = 0;
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      expect(rawRumEvents).toHaveLength(1);
      expect(rawRumEvents[0]).not.toHaveProperty('storageConsent');
    });

    it('preserves an authorized final update when refusal expires the session, then stays inactive while denied', async () => {
      collection.stop();
      histories = new ContextHistoryFactory(consentManager, '/mock/user/data');
      sessionManager = await SessionManager.start(
        eventManager,
        hooks,
        createTestConfiguration(),
        histories,
        consentManager
      );
      collection = RendererProcessContexts.start(eventManager, hooks, consentManager);
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const initialId = (rawRumEvents[0].data as RawRumExecutionContext).execution_context.id;
      vi.advanceTimersByTime(10);
      const boundary = timeStampNow();
      consentManager.update('not-granted');

      expect(rawRumEvents).toHaveLength(2);
      expect(rawRumEvents[1].data).toMatchObject({
        execution_context: { id: initialId, duration: 10e6 },
      });
      expect(rawRumEvents[1]).toMatchObject({ storageConsent: 'granted' });
      rawRumEvents.length = 0;
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      expect(rawRumEvents).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(
        hooks.triggerRum({ eventType: 'error', source: EventSource.RENDERER, webContentsId: 1, startTime: boundary })
      ).toBe(DISCARDED);

      consentManager.update('granted');
      expect(rawRumEvents).toHaveLength(1);
      expect((rawRumEvents[0].data as RawRumExecutionContext).execution_context.id).not.toBe(initialId);
    });

    it('does not authorize the final update of a rejected pending renderer period', () => {
      consentManager.update('pending');
      webContentsCreatedHandler({}, makeWebContents(1));
      vi.advanceTimersByTime(10);

      consentManager.update('not-granted');

      expect(rawRumEvents).toHaveLength(2);
      expect(rawRumEvents[1]).not.toHaveProperty('storageConsent');
    });

    it('does not attribute a window opened between sessions to the renewed session', async () => {
      collection.stop();
      histories = new ContextHistoryFactory(consentManager, '/mock/user/data');
      sessionManager = await SessionManager.start(
        eventManager,
        hooks,
        createTestConfiguration(),
        histories,
        consentManager
      );
      new MainAssembly(eventManager, hooks, new BeforeSend());
      const serverEvents: ServerEvent[] = [];
      eventManager.registerHandler<ServerEvent>({
        canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
        handle: (event) => serverEvents.push(event),
      });
      collection = RendererProcessContexts.start(eventManager, hooks, consentManager);
      sessionManager.expire();
      vi.advanceTimersByTime(10);

      webContentsCreatedHandler({}, makeWebContents(1));
      const gapStart = rawRumEvents[rawRumEvents.length - 1].startTime!;
      expect(serverEvents).toEqual([]);

      vi.advanceTimersByTime(10);
      consentManager.update('pending');

      expect(serverEvents).toMatchObject([
        { data: { type: 'execution_context', date: 20, session: { id: sessionManager.getSession().id } } },
      ]);
      // A terminal update for the gap would still have no session at its capture time.
      expect(hooks.triggerRum({ eventType: 'execution_context', startTime: gapStart, source: EventSource.MAIN })).toBe(
        DISCARDED
      );
    });

    it.each(['before grant', 'after grant'] as const)(
      'tracks windows created while denied only when alive and ready, with reload %s',
      (reload) => {
        consentManager.update('not-granted');
        const live = makeWebContents(1);
        const destroyed = makeWebContents(2);
        const crashed = makeWebContents(3);
        webContentsCreatedHandler({}, live);
        webContentsCreatedHandler({}, destroyed);
        webContentsCreatedHandler({}, crashed);
        destroyed._emit('destroyed');
        crashed._emit('render-process-gone', {}, { reason: 'crashed' });
        if (reload === 'before grant') crashed._emit('did-start-navigation', { isMainFrame: true });
        vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
        expect(rawRumEvents).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);

        consentManager.update('granted');
        expect(rawRumEvents).toHaveLength(reload === 'before grant' ? 2 : 1);
        if (reload === 'after grant') crashed._emit('did-start-navigation', { isMainFrame: true });

        expect(
          rawRumEvents.map((event) => (event.data as RawRumExecutionContext).execution_context.instance_id)
        ).toEqual(['1', '3']);
        rawRumEvents.length = 0;
        vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
        expect(rawRumEvents).toHaveLength(2);
      }
    );

    it('does not rotate a renderer again after a synchronous session renewal for the new consent', () => {
      collection.stop();
      consentManager.subscribe((change) => {
        eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW, time: change.time });
      });
      collection = RendererProcessContexts.start(eventManager, hooks, consentManager);
      webContentsCreatedHandler({}, makeWebContents(1));
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      rawRumEvents.length = 0;

      consentManager.update('pending');

      expect(rawRumEvents).toHaveLength(1);
      expect((rawRumEvents[0].data as RawRumExecutionContext)._dd.document_version).toBe(1);
      rawRumEvents.length = 0;
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      expect(rawRumEvents).toHaveLength(1);
    });

    it('uses the supplied session-expiry boundary for renderer duration', () => {
      webContentsCreatedHandler({}, makeWebContents(1));
      vi.advanceTimersByTime(20);
      eventManager.notify({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.SESSION_EXPIRED,
        time: 10 as TimeStamp,
      });

      expect(rawRumEvents[1].data).toMatchObject({ execution_context: { duration: 10e6 } });
    });

    it('leaves the name unset when web-contents-created fires before any navigation', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const rendererStart = rawRumEvents[base].data as RawRumExecutionContext;
      expect(rendererStart.execution_context.name).toBeUndefined();
    });

    it('resolves and freezes the name from getURL() on dom-ready instead of waiting for the heartbeat', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);

      wc.getURL.mockReturnValue('https://example.com/foo');
      wc._emit('dom-ready');

      expect(rawRumEvents).toHaveLength(base + 2);
      const domReadyEvent = rawRumEvents[base + 1].data as RawRumExecutionContext;
      expect(domReadyEvent.execution_context.name).toBe('https://example.com/foo');
      expect(domReadyEvent._dd.document_version).toBe(2);

      // A later navigation within the same context must not rename it.
      wc.getURL.mockReturnValue('https://example.com/bar');
      wc._emit('dom-ready');
      expect(rawRumEvents).toHaveLength(base + 2);

      expect(
        hooks.triggerRum({ eventType: 'view', startTime: 0 as never, source: EventSource.RENDERER, webContentsId: 1 })
      ).toMatchObject({
        execution_context: { id: domReadyEvent.execution_context.id, name: 'https://example.com/foo' },
      });
    });

    it('does not resolve the name on dom-ready while getURL() is still empty', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);

      wc._emit('dom-ready');

      expect(rawRumEvents).toHaveLength(base + 1);
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

      const freshCollection = RendererProcessContexts.start(freshEventManager, freshHooks, consentManager);

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
      freshCollection.stop();
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

    it('resolves a renderer event still queued when its webContents is destroyed, until the retention window elapses', () => {
      const wc = makeWebContents(1) as unknown as {
        id: number;
        _emit: (event: string, ...args: unknown[]) => void;
      };
      webContentsCreatedHandler({}, wc);
      const startEvent = rawRumEvents[rawRumEvents.length - 1];
      const originalStartTime = startEvent.startTime!;
      const originalId = (startEvent.data as RawRumExecutionContext).execution_context.id;

      // The webContents is destroyed strictly after the event's own startTime — e.g. a final
      // beforeunload-triggered RUM event whose IPC message is still queued when 'destroyed' fires.
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL / 2);
      wc._emit('destroyed');

      // That late event must still resolve its execution_context — the manager isn't torn down
      // immediately, only after a retention window (matching the history's own tolerance).
      expect(
        hooks.triggerRum({
          eventType: 'view',
          startTime: originalStartTime,
          source: EventSource.RENDERER,
          webContentsId: 1,
        })
      ).toMatchObject({ execution_context: { id: originalId } });

      // Once the retention window elapses, the manager is finally disposed and stops resolving —
      // it doesn't linger forever.
      vi.advanceTimersByTime(RENDERER_DISPOSAL_GRACE_PERIOD);
      expect(
        (
          hooks.triggerRum({
            eventType: 'view',
            startTime: originalStartTime,
            source: EventSource.RENDERER,
            webContentsId: 1,
          }) as { execution_context?: unknown } | undefined
        )?.execution_context
      ).toBeUndefined();
    });

    it('detaches the destroyed webContents and its listeners immediately, not just at eventual disposal', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      expect(wc._listenerCount('destroyed')).toBeGreaterThan(0);
      expect(wc._listenerCount('render-process-gone')).toBeGreaterThan(0);

      wc._emit('destroyed');

      // Freed right away — the manager itself lingers for the retention window (see the test
      // above), but must not hold onto the (now dead) webContents or its listeners for that whole
      // window, which would keep it artificially alive and grow every session-boundary scan.
      expect(wc._listenerCount('destroyed')).toBe(0);
      expect(wc._listenerCount('render-process-gone')).toBe(0);
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

    it('does not freeze the revived context name from the stale pre-crash URL, only from its own dom-ready', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      wc.getURL.mockReturnValue('https://example.com/crashed-page');
      wc._emit('dom-ready');

      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      // getURL() still reflects the pre-crash page: did-start-navigation fires before the new
      // navigation commits, so this must not be read as the revived context's real name.
      wc._emit('did-start-navigation', { isMainFrame: true });

      const revived = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(revived.execution_context.name).toBeUndefined();

      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      const afterHeartbeat = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(afterHeartbeat.execution_context.name).toBeUndefined();

      wc.getURL.mockReturnValue('https://example.com/reloaded-page');
      wc._emit('dom-ready');
      const afterDomReady = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(afterDomReady.execution_context.name).toBe('https://example.com/reloaded-page');
    });

    it.each(['pending', 'granted'] as const)('keeps a reload name unresolved across a consent split to %s', (next) => {
      if (next === 'granted') consentManager.update('pending');
      const wc = makeWebContents(1);
      wc.getURL.mockReturnValue('https://example.com/crashed-page');
      webContentsCreatedHandler({}, wc);
      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      wc._emit('did-start-navigation', { isMainFrame: true });

      consentManager.update(next);
      const replacement = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(replacement.execution_context.name).toBeUndefined();
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      expect(
        (rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext).execution_context.name
      ).toBeUndefined();

      wc.getURL.mockReturnValue('https://example.com/reloaded-page');
      wc._emit('dom-ready');
      expect(rawRumEvents[rawRumEvents.length - 1].data).toMatchObject({
        execution_context: { id: replacement.execution_context.id, name: 'https://example.com/reloaded-page' },
      });
    });

    it.each(['before grant', 'after grant'] as const)(
      'resolves a renderer reloaded while denied when dom-ready arrives %s',
      (domReady) => {
        consentManager.update('not-granted');
        const wc = makeWebContents(1);
        wc.getURL.mockReturnValue('https://example.com/crashed-page');
        webContentsCreatedHandler({}, wc);
        wc._emit('render-process-gone', {}, { reason: 'crashed' });
        wc._emit('did-start-navigation', { isMainFrame: true });
        if (domReady === 'before grant') {
          wc.getURL.mockReturnValue('https://example.com/reloaded-page');
          wc._emit('dom-ready');
        }
        expect(rawRumEvents).toEqual([]);

        consentManager.update('granted');
        expect(rawRumEvents).toHaveLength(1);
        if (domReady === 'after grant') {
          const initial = rawRumEvents[0].data as RawRumExecutionContext;
          expect(initial.execution_context.name).toBeUndefined();
          vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
          expect(
            (rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext).execution_context.name
          ).toBeUndefined();
          wc.getURL.mockReturnValue('https://example.com/reloaded-page');
          wc._emit('dom-ready');
        }
        expect(rawRumEvents[rawRumEvents.length - 1].data).toMatchObject({
          execution_context: { name: 'https://example.com/reloaded-page' },
        });
      }
    );

    it('ignores a same-document navigation as a revival signal, since it would never get a dom-ready to clear pendingNavigation', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const firstId = (rawRumEvents[base].data as RawRumExecutionContext).execution_context.id;

      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      // A hash change / pushState on the still-crashed page — must not be read as the revival.
      wc._emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
      expect(rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext).toMatchObject({
        execution_context: { id: firstId },
      });

      // The real revival navigation still works afterward.
      wc._emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      const revived = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(revived.execution_context.id).not.toBe(firstId);
    });

    it('carries the pending-navigation guard through a session renewal that lands before dom-ready', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      wc.getURL.mockReturnValue('https://example.com/crashed-page');
      wc._emit('dom-ready');

      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      // Revival still awaiting its own dom-ready when the session renews — getURL() is stale.
      wc._emit('did-start-navigation', { isMainFrame: true });

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const afterRenewal = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(afterRenewal.execution_context.name).toBeUndefined();

      wc.getURL.mockReturnValue('https://example.com/reloaded-page');
      wc._emit('dom-ready');
      const afterDomReady = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(afterDomReady.execution_context.name).toBe('https://example.com/reloaded-page');
    });

    it('clears the pending-navigation flag from dom-ready even during the sessionless gap, so a later renewal still resolves a name', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);

      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      wc._emit('did-start-navigation', { isMainFrame: true }); // revival, pendingNavigation: true

      // Session expires before the revival's own navigation commits.
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      // The navigation commits with no active entry; its readiness must still be remembered.
      wc.getURL.mockReturnValue('https://example.com/reloaded-page');
      wc._emit('dom-ready');

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const afterRenewal = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(afterRenewal.execution_context.name).toBe('https://example.com/reloaded-page');
    });

    it('clears the pending-navigation flag once the revival commits, so a later renewal still resolves a name', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);

      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      wc._emit('did-start-navigation', { isMainFrame: true });
      wc.getURL.mockReturnValue('https://example.com/reloaded-page');
      wc._emit('dom-ready');

      // No further navigation — the session renews on its own.
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const afterRenewal = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(afterRenewal.execution_context.name).toBe('https://example.com/reloaded-page');
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

    it('ignores dom-ready during the sessionless gap instead of mutating the already-closed context', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);

      // Session expires before this renderer's first navigation ever completes: name is still
      // unset when the terminal update is emitted.
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      const closeEvent = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      const countAfterClose = rawRumEvents.length;
      expect(closeEvent.execution_context.name).toBeUndefined();

      // The navigation finally commits during the sessionless gap.
      wc.getURL.mockReturnValue('https://example.com/foo');
      wc._emit('dom-ready');

      // No stray update for the already-closed context — same invariant a real destroy protects.
      expect(rawRumEvents).toHaveLength(countAfterClose);
      expect(closeEvent._dd.document_version).toBe(2);
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

    it('resolves the name on dom-ready for the renewed context, not the stale pre-renewal one', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const oldId = (rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext).execution_context.id;

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      const newId = (rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext).execution_context.id;
      const countAfterRenewal = rawRumEvents.length;

      wc.getURL.mockReturnValue('https://example.com/foo');
      wc._emit('dom-ready');

      expect(rawRumEvents).toHaveLength(countAfterRenewal + 1);
      const domReadyEvent = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(domReadyEvent.execution_context.id).toBe(newId);
      expect(domReadyEvent.execution_context.id).not.toBe(oldId);
      expect(domReadyEvent.execution_context.name).toBe('https://example.com/foo');
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

    it('does not renew a context whose webContents crashed during the sessionless gap, and does not leak its heartbeat', () => {
      const wc = makeWebContents(1) as unknown as {
        id: number;
        _emit: (event: string, ...args: unknown[]) => void;
      };
      webContentsCreatedHandler({}, wc);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      const countAfterClose = rawRumEvents.length;

      // Crashes while already closed for session expiry — endRenderer must not mistake this
      // already-closed context for one still eligible for renewal.
      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      expect(rawRumEvents).toHaveLength(countAfterClose); // no re-emission of the already-closed context

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      // No spurious execution context for a webContents whose renderer is actually dead.
      const renewedEvents = rawRumEvents
        .slice(countAfterClose)
        .filter((e) => (e.data as RawRumExecutionContext).execution_context.type === 'renderer-process');
      expect(renewedEvents).toHaveLength(0);

      // No heartbeat either — a leaked timer from the crashed context would otherwise still tick.
      rawRumEvents.length = 0;
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      expect(rawRumEvents).toHaveLength(0);

      // The webContents reloading afterward still revives correctly, with exactly one heartbeat.
      wc._emit('did-start-navigation', { isMainFrame: true });
      const revived = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(revived.execution_context.type).toBe('renderer-process');
      rawRumEvents.length = 0;
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      expect(rawRumEvents).toHaveLength(1);
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
