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
import { ViewCollection, SESSION_KEEP_ALIVE_INTERVAL, VIEW_UPDATE_THROTTLE_DELAY } from './ViewCollection';
import {
  EventManager,
  EventKind,
  EventFormat,
  EventSource,
  EventTrack,
  LifecycleKind,
  type RawRumEvent,
} from '../../../event';
import { createFormatHooks, type FormatHooks } from '../../../assembly';
import { createServerRumEvent, createServerRumView, createTestConfiguration } from '../../../mocks.specUtil';
import { RawRumView, MainRumEvent } from '../types';
import { SessionManager } from '../../session';
import { createTrackingConsentState, type TrackingConsentState } from '../../tracking-consent';

vi.mock('node:fs/promises');
const mfs = mockFs();

const T0 = 0 as TimeStamp;
const T10 = 10 as TimeStamp;

describe('ViewCollection', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let viewCollection: ViewCollection;
  let rawRumEvents: RawRumEvent[];
  let trackingConsentState: TrackingConsentState;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mfs.readFile.mockRejectedValue(new Error('ENOENT'));
    mfs.writeFile.mockResolvedValue(undefined);
    eventManager = new EventManager();
    hooks = createFormatHooks();
    rawRumEvents = [];
    trackingConsentState = createTrackingConsentState('granted');

    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });

    viewCollection = await ViewCollection.start(eventManager, hooks, trackingConsentState);
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
      expect(data.view.action.count).toBe(0);
      expect(data.view.error.count).toBe(0);
      expect(data.view.resource.count).toBe(0);
    });

    it('sets date to the view start time, not the update time', () => {
      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);

      const data = rawRumEvents[1].data as RawRumView;
      expect(data.date).toBe(0);
    });
  });

  describe('hook registration', () => {
    it('injects view attributes into RUM hooks', () => {
      const initialViewAttributes = (rawRumEvents[0].data as RawRumView).view;
      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });

      expect(result).toMatchObject({
        view: { id: initialViewAttributes.id },
      });
    });

    it('injects view attributes into telemetry hooks', () => {
      const initialView = (rawRumEvents[0].data as RawRumView).view;
      const result = hooks.triggerTelemetry({ startTime: T0, source: EventSource.MAIN });

      expect(result).toEqual({ view: { id: initialView.id } });
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

  describe('tracking consent boundaries', () => {
    it('closes the current view and starts a new one when storage changes', () => {
      const originalViewId = (rawRumEvents[0].data as RawRumView).view.id;
      vi.advanceTimersByTime(10);

      trackingConsentState.update('pending');

      expect(rawRumEvents).toHaveLength(3);
      const closedView = rawRumEvents[1].data as RawRumView;
      expect(closedView._dd.document_version).toBe(2);
      expect(closedView.view.time_spent).toBe(10 * 1e6);
      expect(closedView.view.is_active).toBe(false);

      const pendingView = rawRumEvents[2].data as RawRumView;
      expect(pendingView.view.id).not.toBe(originalViewId);
      expect(pendingView.view.is_active).toBe(true);
      expect(pendingView._dd.document_version).toBe(1);
    });

    it.each(['granted', 'pending'] as const)(
      'creates only one view when a consent change renews an expired %s session',
      async (initialConsent) => {
        viewCollection.stop();
        hooks = createFormatHooks();
        trackingConsentState = createTrackingConsentState(initialConsent);
        const sessionManager = await SessionManager.start(
          eventManager,
          hooks,
          createTestConfiguration(),
          trackingConsentState
        );
        try {
          viewCollection = await ViewCollection.start(eventManager, hooks, trackingConsentState);
          sessionManager.expire();
          rawRumEvents.length = 0;

          trackingConsentState.update(initialConsent === 'granted' ? 'pending' : 'granted');

          expect(rawRumEvents).toHaveLength(1);
          const renewedView = rawRumEvents[0].data as RawRumView;
          expect(renewedView.view.is_active).toBe(true);
          expect(renewedView._dd.document_version).toBe(1);

          sessionManager.expire();
          expect(rawRumEvents).toHaveLength(2);
          expect((rawRumEvents[1].data as RawRumView).view).toMatchObject({
            id: renewedView.view.id,
            is_active: false,
          });
        } finally {
          sessionManager.stop();
        }
      }
    );

    it('closes the last uploaded view before consent is revoked', () => {
      trackingConsentState.update('not-granted');

      expect(rawRumEvents).toHaveLength(2);
      expect((rawRumEvents[1].data as RawRumView).view.is_active).toBe(false);
    });

    it('does not create an initial view while consent is not granted', async () => {
      viewCollection.stop();
      rawRumEvents.length = 0;
      trackingConsentState = createTrackingConsentState('not-granted');

      viewCollection = await ViewCollection.start(eventManager, hooks, trackingConsentState);

      expect(rawRumEvents).toEqual([]);
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

    it('does not emit another update when the view is already inactive', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      expect(rawRumEvents).toHaveLength(2);
      expect((rawRumEvents[1].data as RawRumView)._dd.document_version).toBe(2);
    });

    it('stops periodic updates after expiration', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);

      // Only initial + final, no periodic update
      expect(rawRumEvents).toHaveLength(2);
    });
  });

  describe('session renew', () => {
    it('creates a new view with reset state', () => {
      const originalViewId = (rawRumEvents[0].data as RawRumView).view.id;

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      expect(rawRumEvents).toHaveLength(2);
      const data = rawRumEvents[1].data as RawRumView;
      expect(data.view.id).not.toBe(originalViewId);
      expect(data.view.is_active).toBe(true);
      expect(data._dd.document_version).toBe(1);
      expect(data.view.action.count).toBe(0);
      expect(data.view.error.count).toBe(0);
      expect(data.view.resource.count).toBe(0);
    });

    it('updates view.id in hooks', () => {
      const originalViewId = (rawRumEvents[0].data as RawRumView).view.id;

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN });
      const newViewId = (rawRumEvents[1].data as RawRumView).view.id;
      expect(result).toMatchObject({ view: { id: newViewId } });
      expect(newViewId).not.toBe(originalViewId);
    });

    it('attributes events with old startTime to the previous view', () => {
      const originalViewId = (rawRumEvents[0].data as RawRumView).view.id;

      vi.advanceTimersByTime(10); // move to T10
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const newViewId = (rawRumEvents[rawRumEvents.length - 1].data as RawRumView).view.id;
      expect(newViewId).not.toBe(originalViewId);

      // event started at T0 (before renewal at T10) → attributed to original view
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN })).toMatchObject({
        view: { id: originalViewId },
      });
      // event started at T10 → attributed to new view
      expect(hooks.triggerRum({ eventType: 'view', startTime: T10, source: EventSource.MAIN })).toMatchObject({
        view: { id: newViewId },
      });
    });

    it('restarts periodic updates', () => {
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);

      // initial + expired final + renew initial + periodic update
      expect(rawRumEvents).toHaveLength(4);
      expect((rawRumEvents[3].data as RawRumView)._dd.document_version).toBe(2);
    });
  });

  describe('event counters', () => {
    it.each(['error', 'resource'] as const)('does not count a delayed %s in the replacement view', (type) => {
      trackingConsentState.update('pending');
      const pendingView = rawRumEvents[rawRumEvents.length - 1].data as RawRumView;
      const captureTime = Date.now() as TimeStamp;
      vi.advanceTimersByTime(10);
      trackingConsentState.update('granted');
      const activeView = rawRumEvents[rawRumEvents.length - 1].data as RawRumView;
      const context = hooks.triggerRum({ eventType: type, startTime: captureTime, source: EventSource.MAIN });
      expect(context).toMatchObject({ view: { id: pendingView.view.id } });
      expect(activeView.view.id).not.toBe(pendingView.view.id);
      const countBefore = rawRumEvents.length;

      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: EventSource.MAIN,
        data: createServerRumEvent<MainRumEvent>(type, { view: { id: pendingView.view.id } }),
      });
      vi.advanceTimersByTime(VIEW_UPDATE_THROTTLE_DELAY);

      expect(rawRumEvents).toHaveLength(countBefore);
      expect(activeView.view[type].count).toBe(0);
    });

    it.each(['error', 'resource'] as const)('increments %s counter on corresponding ServerRumEvent', (type) => {
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: EventSource.MAIN,
        data: createServerRumEvent<MainRumEvent>(type, {
          view: { id: (rawRumEvents[rawRumEvents.length - 1].data as RawRumView).view.id },
        }),
      });

      expect(rawRumEvents).toHaveLength(2);
      const data = rawRumEvents[1].data as RawRumView;
      expect(data.view[type].count).toBe(1);
      expect(data._dd.document_version).toBe(2);
    });

    it('does not count view type ServerEvents', () => {
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: EventSource.MAIN,
        data: createServerRumView(),
      });

      // Only the initial event, no update
      expect(rawRumEvents).toHaveLength(1);
    });

    it('ignores telemetry without a view on the shared RUM track', () => {
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: EventSource.MAIN,
        data: {
          type: 'telemetry',
          date: 0,
          service: 'electron-sdk',
          source: 'electron',
          version: 'test',
          _dd: { format_version: 2 },
          telemetry: { type: 'log', status: 'debug', message: 'test' },
        },
      });

      expect(rawRumEvents).toHaveLength(1);
    });

    it('does not count renderer events', () => {
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: EventSource.RENDERER,
        data: createServerRumEvent('error'),
      });

      // Only the initial event, no update
      expect(rawRumEvents).toHaveLength(1);
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

  describe('throttled view updates', () => {
    function notifyServerRumEvent(type: 'error' | 'resource') {
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        source: EventSource.MAIN,
        data: createServerRumEvent<MainRumEvent>(type, {
          view: { id: (rawRumEvents[rawRumEvents.length - 1].data as RawRumView).view.id },
        }),
      });
    }

    it('collapses a burst into a leading and a trailing update', () => {
      notifyServerRumEvent('resource');
      notifyServerRumEvent('resource');
      notifyServerRumEvent('resource');

      // initial + leading only, no intermediate updates
      expect(rawRumEvents).toHaveLength(2);

      vi.advanceTimersByTime(VIEW_UPDATE_THROTTLE_DELAY);

      // trailing fires with final accumulated state
      expect(rawRumEvents).toHaveLength(3);
    });

    it('trailing update contains final accumulated counters and document_version', () => {
      notifyServerRumEvent('resource');
      notifyServerRumEvent('error');
      notifyServerRumEvent('resource');

      vi.advanceTimersByTime(VIEW_UPDATE_THROTTLE_DELAY);

      const trailing = rawRumEvents[rawRumEvents.length - 1].data as RawRumView;
      expect(trailing.view.resource.count).toBe(2);
      expect(trailing.view.error.count).toBe(1);
      expect(trailing.view.action.count).toBe(0);
      // initial=1, leading=2 (first resource), trailing=4 (after error+resource increments)
      expect(trailing._dd.document_version).toBe(4);
    });

    it('session expired cancels pending trailing update', () => {
      notifyServerRumEvent('resource');
      notifyServerRumEvent('resource');

      // initial + leading
      expect(rawRumEvents).toHaveLength(2);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      vi.advanceTimersByTime(VIEW_UPDATE_THROTTLE_DELAY);

      // initial + leading + expired final — no stale trailing
      expect(rawRumEvents).toHaveLength(3);
      expect((rawRumEvents[2].data as RawRumView).view.is_active).toBe(false);
    });

    it('session renew cancels pending trailing update', () => {
      const originalViewId = (rawRumEvents[0].data as RawRumView).view.id;

      notifyServerRumEvent('resource');
      notifyServerRumEvent('resource');

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      vi.advanceTimersByTime(VIEW_UPDATE_THROTTLE_DELAY);

      // initial + leading + renew initial — no old-view trailing
      expect(rawRumEvents).toHaveLength(3);
      expect((rawRumEvents[2].data as RawRumView).view.id).not.toBe(originalViewId);
    });

    it('stop cancels pending trailing update', () => {
      notifyServerRumEvent('resource');
      notifyServerRumEvent('resource');

      viewCollection.stop();

      vi.advanceTimersByTime(VIEW_UPDATE_THROTTLE_DELAY);

      // initial + leading — no trailing after stop
      expect(rawRumEvents).toHaveLength(2);
    });
  });
});
