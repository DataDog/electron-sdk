import { mockFs } from '../../../mocks.specUtil';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

vi.mock('../../../tools/display', () => ({
  display: { error: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { ViewCollection, SESSION_KEEP_ALIVE_INTERVAL } from './ViewCollection';
import { EventManager, EventKind, EventFormat, EventSource, LifecycleKind, type RawRumEvent } from '../../../event';
import { createFormatHooks, type FormatHooks } from '../../../assembly';
import { SessionManager } from '../../session';
import { RawRumView } from '../rawRumData.types';

vi.mock('node:fs/promises');
const mfs = mockFs();

const T0 = 0 as TimeStamp;
const T10 = 10 as TimeStamp;

describe('ViewCollection', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let viewCollection: ViewCollection;
  let rawRumEvents: RawRumEvent[];
  let mockSessionManager: { getSession: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);
    eventManager = new EventManager();
    hooks = createFormatHooks();
    rawRumEvents = [];

    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });

    mockSessionManager = { getSession: vi.fn().mockReturnValue({ id: 'session-id-1', status: 'active' }) };
    viewCollection = await ViewCollection.start(eventManager, hooks, mockSessionManager as unknown as SessionManager);
  });

  afterEach(() => {
    viewCollection.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  describe('initial view event', () => {
    it('emits initial view event on creation', () => {
      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumView;
      expect(data.type).toBe('view');
      expect(data.date).toBe(0);
      expect(data._dd.document_version).toBe(1);
      expect(data.view.is_active).toBe(true);
    });

    it('uses session.id as view.id', () => {
      const data = rawRumEvents[0].data as RawRumView;
      expect(data.view.id).toBe('session-id-1');
    });

    it('sets date to the view start time, not the update time', () => {
      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);

      const data = rawRumEvents[1].data as RawRumView;
      expect(data.date).toBe(0);
    });
  });

  describe('hook registration', () => {
    it('injects view attributes into RUM hooks', () => {
      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });

      expect(result).toMatchObject({
        view: { id: 'session-id-1' },
      });
    });

    it('injects view attributes into telemetry hooks', () => {
      const result = hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN });

      expect(result).toEqual({ view: { id: 'session-id-1' } });
    });
  });

  describe('session keep alive', () => {
    it('increments document_version and updates time_spent regularly', () => {
      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);

      expect(rawRumEvents).toHaveLength(2);
      const data = rawRumEvents[1].data as RawRumView;
      expect(data._dd.document_version).toBe(2);
      expect(data.view.time_spent).toBe(SESSION_KEEP_ALIVE_INTERVAL * 1e6); // duration in ns
      expect(data.view.is_active).toBe(true);
    });
  });

  describe('session expired', () => {
    it('emits final view update with is_active false', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      expect(rawRumEvents).toHaveLength(2);
      const data = rawRumEvents[1].data as RawRumView;
      expect(data.view.is_active).toBe(false);
      expect(data._dd.document_version).toBe(2);
    });

    it('stops periodic updates after expiration', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);

      // Only initial + final, no periodic update
      expect(rawRumEvents).toHaveLength(2);
    });
  });

  describe('session renew', () => {
    it('creates a new view with reset state using new session.id', () => {
      mockSessionManager.getSession.mockReturnValue({ id: 'session-id-2', status: 'active' });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(rawRumEvents).toHaveLength(2);
      const data = rawRumEvents[1].data as RawRumView;
      expect(data.view.id).toBe('session-id-2');
      expect(data.view.is_active).toBe(true);
      expect(data._dd.document_version).toBe(1);
    });

    it('updates view.id in hooks to new session.id', () => {
      mockSessionManager.getSession.mockReturnValue({ id: 'session-id-2', status: 'active' });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
      expect(result).toMatchObject({ view: { id: 'session-id-2' } });
    });

    it('attributes events with old startTime to the previous view', () => {
      vi.advanceTimersByTime(10); // move to T10
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      mockSessionManager.getSession.mockReturnValue({ id: 'session-id-2', status: 'active' });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      // event started at T0 (before renewal at T10) → attributed to original view
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toMatchObject({
        view: { id: 'session-id-1' },
      });
      // event started at T10 → attributed to new view
      expect(hooks.triggerRum({ eventType: 'view', startTime: T10, source: EventSource.MAIN })).toMatchObject({
        view: { id: 'session-id-2' },
      });
    });

    it('restarts periodic updates', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      mockSessionManager.getSession.mockReturnValue({ id: 'session-id-2', status: 'active' });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);

      // initial + expired final + renew initial + periodic update
      expect(rawRumEvents).toHaveLength(4);
      expect((rawRumEvents[3].data as RawRumView)._dd.document_version).toBe(2);
    });
  });

  describe('stop', () => {
    it('clears periodic timer and unsubscribes lifecycle handlers', () => {
      viewCollection.stop();

      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      // Only the initial event, nothing else
      expect(rawRumEvents).toHaveLength(1);
    });
  });
});
