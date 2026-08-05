vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    getAppMetrics: vi.fn(() => []),
  },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';
import { ExecutionContextCollection, PROCESS_UPDATE_INTERVAL } from './ExecutionContextCollection';
import { EventManager, EventKind, EventFormat, LifecycleKind, type RawRumEvent } from '../../../event';
import { RawRumExecutionContext } from '../rawRumData.types';

describe('ExecutionContextCollection', () => {
  let eventManager: EventManager;
  let rawRumEvents: RawRumEvent[];
  let executionContextCollection: ExecutionContextCollection;
  let webContentsCreatedHandler: (event: unknown, webContents: unknown) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    eventManager = new EventManager();
    rawRumEvents = [];
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (e): e is RawRumEvent => e.kind === EventKind.RAW && e.format === EventFormat.RUM,
      handle: (e) => rawRumEvents.push(e),
    });

    // Capture the web-contents-created handler registered by ExecutionContextCollection
    vi.mocked(app).on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'web-contents-created') {
        webContentsCreatedHandler = handler;
      }
      return app;
    });

    executionContextCollection = ExecutionContextCollection.start(eventManager);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('main process', () => {
    it('emits a start event on init', () => {
      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumExecutionContext;
      expect(data.type).toBe('execution_context');
      expect(data.execution_context.type).toBe('main-process');
      expect(data.execution_context.instance_id).toBe(String(process.pid));
      expect(data._dd.document_version).toBe(1);
      expect(data.execution_context.duration).toBeUndefined();
    });

    it('emits a periodic update every minute with incremented document_version', () => {
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      expect(rawRumEvents).toHaveLength(2);
      const update = rawRumEvents[1].data as RawRumExecutionContext;
      expect(update._dd.document_version).toBe(2);
      expect(update.execution_context.duration).toBeGreaterThanOrEqual(0);
    });

    it('emits a final update with is_active false on SESSION_EXPIRED', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      const last = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(last.execution_context.exit_reason).toBeUndefined();
    });

    it('stops emitting updates after SESSION_EXPIRED', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      const countAfterExpiry = rawRumEvents.length;
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL * 3);
      expect(rawRumEvents).toHaveLength(countAfterExpiry); // no new events from timer
    });
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
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      expect(rawRumEvents).toHaveLength(2); // main start + renderer start
      const rendererStart = rawRumEvents[1].data as RawRumExecutionContext;
      expect(rendererStart.execution_context.type).toBe('renderer-process');
      expect(rendererStart.execution_context.instance_id).toBe('1001');
      expect(rendererStart._dd.document_version).toBe(1);
    });

    it('registers the renderer in ExecutionContextAttributes', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const ctx = executionContextCollection.executionContextAttributes.getRendererExecutionContext(1);
      expect(ctx).toBeDefined();
      expect(ctx?.type).toBe('renderer-process');
    });

    it('emits an end event on webContents destroyed', () => {
      const wc = makeWebContents(2);
      webContentsCreatedHandler({}, wc);
      wc._emit('destroyed');
      const last = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(last.execution_context.exit_reason).toBeUndefined();
      expect(executionContextCollection.executionContextAttributes.getRendererExecutionContext(2)).toBeUndefined();
    });

    it('emits an end event with exit_reason on render-process-gone', () => {
      const wc = makeWebContents(3);
      webContentsCreatedHandler({}, wc);
      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      const last = rawRumEvents[rawRumEvents.length - 1].data as RawRumExecutionContext;
      expect(last.execution_context.exit_reason).toBe('crashed');
    });

    it('removes renderer from ExecutionContextAttributes after end', () => {
      const wc = makeWebContents(4);
      webContentsCreatedHandler({}, wc);
      wc._emit('destroyed');
      expect(executionContextCollection.executionContextAttributes.getRendererExecutionContext(4)).toBeUndefined();
    });
  });
});
