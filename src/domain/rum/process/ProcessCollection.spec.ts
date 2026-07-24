vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    getAppMetrics: vi.fn(() => []),
  },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';
import { ProcessCollection, PROCESS_UPDATE_INTERVAL } from './ProcessCollection';
import { EventManager, EventKind, EventFormat, LifecycleKind, type RawRumEvent } from '../../../event';
import { RawRumProcess } from '../rawRumData.types';

describe('ProcessCollection', () => {
  let eventManager: EventManager;
  let rawRumEvents: RawRumEvent[];
  let processCollection: ProcessCollection;
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

    // Capture the web-contents-created handler registered by ProcessCollection
    vi.mocked(app).on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'web-contents-created') {
        webContentsCreatedHandler = handler;
      }
      return app;
    });

    processCollection = ProcessCollection.start(eventManager);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('main process', () => {
    it('emits a start event on init', () => {
      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumProcess;
      expect(data.type).toBe('process');
      expect(data.process.role).toBe('main');
      expect(data.process.pid).toBe(process.pid);
      expect(data._dd.document_version).toBe(1);
      expect(data.process.duration).toBeUndefined();
    });

    it('emits a periodic update every minute with incremented document_version', () => {
      vi.advanceTimersByTime(PROCESS_UPDATE_INTERVAL);
      expect(rawRumEvents).toHaveLength(2);
      const update = rawRumEvents[1].data as RawRumProcess;
      expect(update._dd.document_version).toBe(2);
      expect(update.process.duration).toBeGreaterThanOrEqual(0);
    });

    it('emits a final update with is_active false on SESSION_EXPIRED', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      const last = rawRumEvents[rawRumEvents.length - 1].data as RawRumProcess;
      expect(last.process.exit_reason).toBeUndefined();
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
      const rendererStart = rawRumEvents[1].data as RawRumProcess;
      expect(rendererStart.process.role).toBe('renderer');
      expect(rendererStart.process.pid).toBe(1001);
      expect(rendererStart._dd.document_version).toBe(1);
    });

    it('registers the renderer in ProcessContext', () => {
      const wc = makeWebContents(1);
      webContentsCreatedHandler({}, wc);
      const ctx = processCollection.processContext.getRendererProcessContext(1);
      expect(ctx).toBeDefined();
      expect(ctx?.role).toBe('renderer');
    });

    it('emits an end event on webContents destroyed', () => {
      const wc = makeWebContents(2);
      webContentsCreatedHandler({}, wc);
      wc._emit('destroyed');
      const last = rawRumEvents[rawRumEvents.length - 1].data as RawRumProcess;
      expect(last.process.exit_reason).toBeUndefined();
      expect(processCollection.processContext.getRendererProcessContext(2)).toBeUndefined();
    });

    it('emits an end event with exit_reason on render-process-gone', () => {
      const wc = makeWebContents(3);
      webContentsCreatedHandler({}, wc);
      wc._emit('render-process-gone', {}, { reason: 'crashed' });
      const last = rawRumEvents[rawRumEvents.length - 1].data as RawRumProcess;
      expect(last.process.exit_reason).toBe('crashed');
    });

    it('removes renderer from ProcessContext after end', () => {
      const wc = makeWebContents(4);
      webContentsCreatedHandler({}, wc);
      wc._emit('destroyed');
      expect(processCollection.processContext.getRendererProcessContext(4)).toBeUndefined();
    });
  });
});
