import { mockFs } from '../../../mocks.specUtil';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';
import { ExecutionContextCollection } from './ExecutionContextCollection';
import { PROCESS_UPDATE_INTERVAL } from './constants';
import { EventManager, EventKind, EventFormat, EventSource, LifecycleKind, type RawRumEvent } from '../../../event';
import { createFormatHooks } from '../../../assembly';
import type { SessionManager } from '../../session';
import type { RawRumExecutionContext } from '../types';

vi.mock('node:fs/promises');
const mfs = mockFs();

describe('ExecutionContextCollection', () => {
  let eventManager: EventManager;
  let hooks: ReturnType<typeof createFormatHooks>;
  let rawRumEvents: RawRumEvent[];
  let sessionManager: SessionManager;
  let collection: ExecutionContextCollection;
  let webContentsCreatedHandler: (event: unknown, webContents: unknown) => void;

  beforeEach(async () => {
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
    sessionManager = { getSession: () => ({ id: 'session-1', status: 'tracked' }) } as unknown as SessionManager;

    vi.mocked(app).on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'web-contents-created') {
        webContentsCreatedHandler = handler;
      }
      return app;
    });

    collection = await ExecutionContextCollection.start(eventManager, hooks, sessionManager);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  describe('renderer processes', () => {
    function makeWebContents(id: number) {
      const listeners: Record<string, (...args: unknown[]) => void> = {};
      return {
        id,
        getProcessId: vi.fn(() => 1000 + id),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          listeners[event] = handler;
        }),
        _emit: (event: string, ...args: unknown[]) => listeners[event]?.(...args),
      };
    }

    it('emits a start event when web-contents-created fires', () => {
      const base = rawRumEvents.length; // the initial main-process view + execution_context events
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      expect(rawRumEvents).toHaveLength(base + 1);
      const rendererStart = rawRumEvents[base].data as RawRumExecutionContext;
      expect(rendererStart.execution_context.type).toBe('renderer-process');
      expect(rendererStart.execution_context.instance_id).toBe('1001');
      expect(rendererStart._dd.document_version).toBe(1);
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
      expect(rendererEnd.execution_context.exit_reason).toBeUndefined();

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

    it('stop() clears a renderer heartbeat timer too', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const countAfterStart = rawRumEvents.length;

      collection.stop();
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL * 3);
      expect(rawRumEvents).toHaveLength(countAfterStart);
    });

    it('closes the renderer context on SESSION_EXPIRED without deleting or tagging an exit_reason', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const rendererId = (rawRumEvents[base].data as RawRumExecutionContext).execution_context.id;

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

    it('reopens a new renderer context on SESSION_RENEW with a new id but the same instance_id', () => {
      const base = rawRumEvents.length;
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const oldId = (rawRumEvents[base].data as RawRumExecutionContext).execution_context.id;

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const newContext = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(newContext.execution_context.id).not.toBe(oldId);
      expect(newContext.execution_context.instance_id).toBe('1001');
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
      expect(started.execution_context.instance_id).toBe('1002');
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
