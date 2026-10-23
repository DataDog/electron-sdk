import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventFormat, EventKind, EventTrack, EventManager, EventSource, LifecycleKind } from '../../event';
import type { ServerReplayEvent } from '../../event';
import { createFormatHooks } from '../../assembly';
import { addError } from '../telemetry';
import { ReplayCollection } from './ReplayCollection';
import type { Configuration } from '../../config';
import { createTestConfiguration } from '../../mocks.specUtil';
import type { SessionManager } from '../session';
import { CreationReason } from './Segment';
import type { ReplaySegmentPayload } from './Segment';
import { createTrackingConsentState } from '../tracking-consent';

const { mockStreamingDeflateConstructor } = vi.hoisted(() => ({
  mockStreamingDeflateConstructor: vi.fn(),
}));

vi.mock('../telemetry', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  monitor: (fn: Function) => fn,
  setTimeout: (callback: () => void, delay?: number) => global.setTimeout(callback, delay),
  clearTimeout: (timeoutId: ReturnType<typeof global.setTimeout>) => global.clearTimeout(timeoutId),
  addError: vi.fn(),
}));

vi.mock('../../tools/StreamingDeflate', () => ({
  StreamingDeflate: class {
    constructor() {
      mockStreamingDeflateConstructor();
    }

    compressSegment = vi.fn().mockResolvedValue(Buffer.from('compressed'));
  },
}));

function makeConfig(overrides?: Partial<Configuration>): Configuration {
  return createTestConfiguration({ applicationId: 'app-1', ...overrides });
}

function makeSessionManager(id = 'sess-1', status: 'active' | 'expired' = 'active'): SessionManager {
  return {
    getSession: () => ({ id, status }),
    // Every record timestamp resolves to this session while active, so the boundary guard passes;
    // an expired session is not tracked, so it resolves to undefined.
    getTrackedSessionId: () => (status === 'active' ? id : undefined),
  } as unknown as SessionManager;
}

function makeHooks() {
  return createFormatHooks();
}

function sendRecord(
  eventManager: EventManager,
  record: { type: number; timestamp: number; [key: string]: unknown },
  viewId = 'view-1'
) {
  eventManager.notify({
    kind: EventKind.RAW,
    source: EventSource.RENDERER,
    format: EventFormat.REPLAY,
    data: record,
    view: { id: viewId },
  });
}

function captureReplayEvents(eventManager: EventManager): ReplaySegmentPayload[] {
  const captured: ReplaySegmentPayload[] = [];
  eventManager.registerHandler<ServerReplayEvent>({
    canHandle: (event): event is ServerReplayEvent =>
      event.kind === EventKind.SERVER && event.track === EventTrack.REPLAY,
    handle: (event) => captured.push(event.data),
  });
  return captured;
}

describe('ReplayCollection', () => {
  let eventManager: EventManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    eventManager = new EventManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('idle behaviour', () => {
    it('emits nothing when no records are received', () => {
      const captured = captureReplayEvents(eventManager);
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());

      vi.advanceTimersByTime(10_000);
      expect(captured).toHaveLength(0);
    });

    it('does not collect records when session is expired', () => {
      const captured = captureReplayEvents(eventManager);
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager('sess-1', 'expired'), makeHooks());

      sendRecord(eventManager, { type: 3, timestamp: 100 });
      vi.advanceTimersByTime(10_000);
      expect(captured).toHaveLength(0);
    });
  });

  describe('session replay sampling', () => {
    it('uses the parent-corrected replay rate for the session ID', () => {
      const captured = captureReplayEvents(eventManager);
      const highHashSessionId = '5321b54a-d6ec-4b24-996d-dd70c617e09a';
      const config = makeConfig({ sessionSampleRate: 50, sessionReplaySampleRate: 100 });
      new ReplayCollection(eventManager, config, makeSessionManager(highHashSessionId), makeHooks());

      sendRecord(eventManager, { type: 3, timestamp: 100 });
      vi.advanceTimersByTime(5_000);

      expect(captured).toHaveLength(0);
    });
  });

  describe('duration-based flush (5 s timer)', () => {
    it('flushes segment after 5 s and emits a ServerReplayEvent', async () => {
      const captured = captureReplayEvents(eventManager);
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());

      sendRecord(eventManager, { type: 2, timestamp: 1000 });
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      expect(captured).toHaveLength(1);
      expect(captured[0].metadata.records_count).toBe(1);
      expect(captured[0].metadata.application.id).toBe('app-1');
      expect(captured[0].metadata.session.id).toBe('sess-1');
      expect(captured[0].metadata.view.id).toBe('view-1');
    });

    it('accumulates multiple records into a single segment', async () => {
      const captured = captureReplayEvents(eventManager);
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());

      sendRecord(eventManager, { type: 4, timestamp: 100 });
      sendRecord(eventManager, { type: 2, timestamp: 200 });
      sendRecord(eventManager, { type: 3, timestamp: 300 });
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      expect(captured).toHaveLength(1);
      expect(captured[0].metadata.records_count).toBe(3);
      expect(captured[0].metadata.start).toBe(100);
      expect(captured[0].metadata.end).toBe(300);
      expect(captured[0].metadata.has_full_snapshot).toBe(true);
    });

    it('splits a segment when consent changes so storage decisions cannot mix', async () => {
      const captured = captureReplayEvents(eventManager);
      const state = createTrackingConsentState('granted');
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks(), state);

      sendRecord(eventManager, { type: 2, timestamp: 100 });
      state.update('pending');
      sendRecord(eventManager, { type: 3, timestamp: 200 });
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      expect(captured).toHaveLength(2);
      expect(captured[0].metadata).toMatchObject({ start: 100, end: 100, records_count: 1 });
      expect(captured[1].metadata).toMatchObject({ start: 200, end: 200, records_count: 1 });
    });

    it('splits delayed records according to their capture-time consent', async () => {
      vi.setSystemTime(1_000);
      const captured = captureReplayEvents(eventManager);
      const state = createTrackingConsentState('granted');
      const collection = new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks(), state);
      state.update('pending');

      sendRecord(eventManager, { type: 2, timestamp: 900 });
      sendRecord(eventManager, { type: 3, timestamp: 1_100 });
      await collection.stop();

      expect(captured).toHaveLength(2);
      expect(captured[0].metadata).toMatchObject({ start: 900, end: 900, records_count: 1 });
      expect(captured[1].metadata).toMatchObject({ start: 1_100, end: 1_100, records_count: 1 });
    });

    it('drops delayed records from a rejected pending interval', async () => {
      vi.setSystemTime(1_000);
      const captured = captureReplayEvents(eventManager);
      const state = createTrackingConsentState('pending');
      const collection = new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks(), state);
      state.update('not-granted');

      sendRecord(eventManager, { type: 2, timestamp: 900 });
      await collection.stop();

      expect(captured).toHaveLength(0);
    });
  });

  describe('replay after denied consent', () => {
    it('waits for a fresh full snapshot per Browser view, preserving Meta and Focus records', async () => {
      vi.setSystemTime(1000);
      const state = createTrackingConsentState('not-granted');
      const captured = captureReplayEvents(eventManager);
      const collection = new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks(), state);
      sendRecord(eventManager, { type: 2, timestamp: 1000 });
      vi.setSystemTime(2000);
      state.update('granted');
      sendRecord(eventManager, { type: 2, timestamp: 1000 });
      sendRecord(eventManager, { type: 3, timestamp: 2000 });
      sendRecord(eventManager, { type: 12, timestamp: 2000 });
      sendRecord(eventManager, { type: 4, timestamp: 2000 });
      sendRecord(eventManager, { type: 6, timestamp: 2000 });
      await collection.stop();
      expect(captured).toEqual([]);

      sendRecord(eventManager, { type: 2, timestamp: 2001 });
      sendRecord(eventManager, { type: 3, timestamp: 2002 });
      sendRecord(eventManager, { type: 3, timestamp: 2002 }, 'other-view');
      await collection.stop();
      expect(captured).toHaveLength(1);
      expect(captured[0].metadata).toMatchObject({ view: { id: 'view-1' }, records_count: 4, has_full_snapshot: true });
    });

    it('requires another full snapshot after revocation even for an already recorded view', async () => {
      vi.setSystemTime(1000);
      const state = createTrackingConsentState('not-granted');
      const captured = captureReplayEvents(eventManager);
      const collection = new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks(), state);
      state.update('granted');
      sendRecord(eventManager, { type: 2, timestamp: 1000 });
      await collection.stop();
      vi.setSystemTime(2000);
      state.update('not-granted');
      sendRecord(eventManager, { type: 2, timestamp: 2000 });
      vi.setSystemTime(3000);
      state.update('granted');
      sendRecord(eventManager, { type: 3, timestamp: 3000 });
      await collection.stop();
      expect(captured).toHaveLength(1);
      sendRecord(eventManager, { type: 2, timestamp: 3001 });
      await collection.stop();
      expect(captured).toHaveLength(2);
    });
  });

  describe('view-change flush', () => {
    it('flushes when the view ID changes', async () => {
      const captured = captureReplayEvents(eventManager);
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());

      sendRecord(eventManager, { type: 3, timestamp: 100 }, 'view-1');
      sendRecord(eventManager, { type: 3, timestamp: 200 }, 'view-2');
      await Promise.resolve();

      expect(captured).toHaveLength(1);
      expect(captured[0].metadata.view.id).toBe('view-1');
    });

    it('sets creation_reason to view_change on the next segment', async () => {
      const captured = captureReplayEvents(eventManager);
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());

      sendRecord(eventManager, { type: 3, timestamp: 100 }, 'view-1');
      sendRecord(eventManager, { type: 3, timestamp: 200 }, 'view-2');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      expect(captured).toHaveLength(2);
      expect(captured[1].metadata.creation_reason).toBe(CreationReason.VIEW_CHANGE);
    });
  });

  describe('session lifecycle flush', () => {
    it('flushes on SESSION_EXPIRED', async () => {
      const captured = captureReplayEvents(eventManager);
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());

      sendRecord(eventManager, { type: 3, timestamp: 100 });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      await Promise.resolve();

      expect(captured).toHaveLength(1);
    });

    it('resets the compression context and per-view state on SESSION_RENEW', async () => {
      const captured = captureReplayEvents(eventManager);
      let session = { id: 'sess-1', status: 'active' as 'active' | 'expired' };
      const sessionManager = {
        getSession: () => ({ ...session }),
        getTrackedSessionId: () => (session.status === 'active' ? session.id : undefined),
      } as unknown as SessionManager;
      const collection = new ReplayCollection(eventManager, makeConfig(), sessionManager, makeHooks());

      sendRecord(eventManager, { type: 3, timestamp: 100 }, 'view-1');
      session = { ...session, status: 'expired' };
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      await Promise.resolve();

      expect(collection.getViewReplayStats('view-1')).toBeDefined();

      session = { id: 'sess-2', status: 'active' };
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(collection.getViewReplayStats('view-1')).toBeUndefined();

      sendRecord(eventManager, { type: 3, timestamp: 200 }, 'view-1');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      expect(mockStreamingDeflateConstructor).toHaveBeenCalledTimes(2);
      expect(captured).toHaveLength(2);
      expect(captured[1].metadata.session.id).toBe('sess-2');
      expect(captured[1].metadata.index_in_view).toBe(0);
    });
  });

  describe('segment indexing', () => {
    it('increments index_in_view for successive segments in the same view', async () => {
      const captured = captureReplayEvents(eventManager);
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());

      sendRecord(eventManager, { type: 3, timestamp: 100 }, 'view-1');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      sendRecord(eventManager, { type: 3, timestamp: 200 }, 'view-1');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      expect(captured[0].metadata.index_in_view).toBe(0);
      expect(captured[1].metadata.index_in_view).toBe(1);
    });

    it('resets index_in_view for a new view', async () => {
      const captured = captureReplayEvents(eventManager);
      new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());

      sendRecord(eventManager, { type: 3, timestamp: 100 }, 'view-1');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      sendRecord(eventManager, { type: 3, timestamp: 200 }, 'view-2');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      expect(captured[0].metadata.index_in_view).toBe(0);
      expect(captured[1].metadata.index_in_view).toBe(0);
    });
  });

  describe('getViewReplayStats()', () => {
    it('returns stats accumulated for a view after flushing', async () => {
      const collection = new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());
      captureReplayEvents(eventManager);

      sendRecord(eventManager, { type: 3, timestamp: 100 }, 'view-abc');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      const stats = collection.getViewReplayStats('view-abc');
      expect(stats).toBeDefined();
      expect(stats!.segments_count).toBe(1);
      expect(stats!.segments_total_raw_size).toBeGreaterThan(0);
    });

    it('returns undefined for a view with no segments', () => {
      const collection = new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());
      expect(collection.getViewReplayStats('unknown-view')).toBeUndefined();
    });
  });

  describe('stop()', () => {
    it('flushes pending segment before resolving', async () => {
      const captured = captureReplayEvents(eventManager);
      const collection = new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());

      sendRecord(eventManager, { type: 3, timestamp: 100 });
      await collection.stop();

      expect(captured).toHaveLength(1);
    });

    it('resolves immediately if no records are pending', async () => {
      const collection = new ReplayCollection(eventManager, makeConfig(), makeSessionManager(), makeHooks());
      await expect(collection.stop()).resolves.toBeUndefined();
    });
  });

  // A record delayed across a session boundary (inactivity/timeout → renewal) must not be compressed
  // into the current session's deflate stream — that would misattribute it and corrupt stitching.
  describe('session boundary guard', () => {
    it('drops a record captured under a different tracked session and reports telemetry', async () => {
      const captured = captureReplayEvents(eventManager);
      // Record ts=100 resolves to sess-A; "now" (the default) resolves to the current session sess-B.
      const sessionManager = {
        getSession: () => ({ id: 'sess-B', status: 'active' as const }),
        getTrackedSessionId: (at = 1000) => (at < 1000 ? 'sess-A' : 'sess-B'),
      } as unknown as SessionManager;
      const collection = new ReplayCollection(eventManager, makeConfig(), sessionManager, makeHooks());

      sendRecord(eventManager, { type: 2, timestamp: 100 });
      await collection.stop();

      expect(captured).toHaveLength(0);
      expect(addError).toHaveBeenCalledTimes(1);
    });

    it('does not report telemetry for records of an untracked/unsampled session (no mismatch)', async () => {
      const captured = captureReplayEvents(eventManager);
      // Not tracked (e.g. session not sampled): both lookups are undefined, so there is no mismatch —
      // the record is dropped silently by the replay-sampling path, without boundary telemetry.
      const sessionManager = {
        getSession: () => ({ id: 'sess-x', status: 'active' as const }),
        getTrackedSessionId: () => undefined,
      } as unknown as SessionManager;
      const collection = new ReplayCollection(
        eventManager,
        makeConfig({ sessionReplaySampleRate: 0 }),
        sessionManager,
        makeHooks()
      );

      sendRecord(eventManager, { type: 2, timestamp: 100 });
      await collection.stop();

      expect(captured).toHaveLength(0);
      expect(addError).not.toHaveBeenCalled();
    });
  });
});
