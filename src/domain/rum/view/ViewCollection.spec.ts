import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type TimeStamp } from '@datadog/browser-core';
import { ViewCollection, SESSION_KEEP_ALIVE_INTERVAL, VIEW_UPDATE_THROTTLE_DELAY } from './ViewCollection';
import { EventManager, EventKind, EventFormat, EventTrack, LifecycleKind, type RawRumEvent } from '../../../event';
import { createFormatHooks, type FormatHooks } from '../../../assembly';
import { createServerRumEvent, createServerRumView } from '../../../mocks.specUtil';
import { RawRumView } from '../rawRumData.types';

const T0 = 0 as TimeStamp;
const T10 = 10 as TimeStamp;

describe('ViewCollection', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let viewCollection: ViewCollection;
  let rawRumEvents: RawRumEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    eventManager = new EventManager();
    hooks = createFormatHooks();
    rawRumEvents = [];

    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });
  });

  afterEach(() => {
    viewCollection.stop();
    vi.useRealTimers();
  });

  describe('initial view event', () => {
    it('emits initial view event on creation', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumView;
      expect(data.type).toBe('view');
      expect(data._dd.document_version).toBe(1);
      expect(data.view.is_active).toBe(true);
      expect(data.view.action.count).toBe(0);
      expect(data.view.error.count).toBe(0);
      expect(data.view.resource.count).toBe(0);
    });
  });

  describe('hook registration', () => {
    it('injects view attributes into RUM hooks', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

      const initialViewAttributes = (rawRumEvents[0].data as RawRumView).view;
      const result = hooks.triggerRum({ eventType: 'view', startTime: T0 });

      expect(result).toMatchObject({
        view: { id: initialViewAttributes.id },
      });
    });

    it('injects view attributes into telemetry hooks', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

      const initialView = (rawRumEvents[0].data as RawRumView).view;
      const result = hooks.triggerTelemetry({ startTime: T0 });

      expect(result).toEqual({ view: { id: initialView.id } });
    });
  });

  describe('session keep alive', () => {
    it('increments document_version and updates time_spent regularly', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

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
      viewCollection = new ViewCollection(eventManager, hooks);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      expect(rawRumEvents).toHaveLength(2);
      const data = rawRumEvents[1].data as RawRumView;
      expect(data.view.is_active).toBe(false);
      expect(data._dd.document_version).toBe(2);
    });

    it('stops periodic updates after expiration', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);

      // Only initial + final, no periodic update
      expect(rawRumEvents).toHaveLength(2);
    });
  });

  describe('session renew', () => {
    it('creates a new view with reset state', () => {
      viewCollection = new ViewCollection(eventManager, hooks);
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
      viewCollection = new ViewCollection(eventManager, hooks);
      const originalViewId = (rawRumEvents[0].data as RawRumView).view.id;

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const result = hooks.triggerRum({ eventType: 'view', startTime: T0 });
      const newViewId = (rawRumEvents[1].data as RawRumView).view.id;
      expect(result).toMatchObject({ view: { id: newViewId } });
      expect(newViewId).not.toBe(originalViewId);
    });

    it('attributes events with old startTime to the previous view', () => {
      viewCollection = new ViewCollection(eventManager, hooks);
      const originalViewId = (rawRumEvents[0].data as RawRumView).view.id;

      vi.advanceTimersByTime(10); // move to T10
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

      const newViewId = (rawRumEvents[rawRumEvents.length - 1].data as RawRumView).view.id;
      expect(newViewId).not.toBe(originalViewId);

      // event started at T0 (before renewal at T10) → attributed to original view
      expect(hooks.triggerRum({ eventType: 'view', startTime: T0 })).toMatchObject({ view: { id: originalViewId } });
      // event started at T10 → attributed to new view
      expect(hooks.triggerRum({ eventType: 'view', startTime: T10 })).toMatchObject({ view: { id: newViewId } });
    });

    it('restarts periodic updates', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);

      // initial + expired final + renew initial + periodic update
      expect(rawRumEvents).toHaveLength(4);
      expect((rawRumEvents[3].data as RawRumView)._dd.document_version).toBe(2);
    });
  });

  describe('event counters', () => {
    it.each(['action', 'error', 'resource'] as const)(
      'increments %s counter on corresponding ServerRumEvent',
      (type) => {
        viewCollection = new ViewCollection(eventManager, hooks);

        eventManager.notify({ kind: EventKind.SERVER, track: EventTrack.RUM, data: createServerRumEvent(type) });

        expect(rawRumEvents).toHaveLength(2);
        const data = rawRumEvents[1].data as RawRumView;
        expect(data.view[type].count).toBe(1);
        expect(data._dd.document_version).toBe(2);
      }
    );

    it('does not count view type ServerEvents', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

      eventManager.notify({ kind: EventKind.SERVER, track: EventTrack.RUM, data: createServerRumView() });

      // Only the initial event, no update
      expect(rawRumEvents).toHaveLength(1);
    });
  });

  describe('stop', () => {
    it('clears periodic timer and unsubscribes lifecycle handlers', () => {
      viewCollection = new ViewCollection(eventManager, hooks);
      viewCollection.stop();

      vi.advanceTimersByTime(SESSION_KEEP_ALIVE_INTERVAL);
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

      // Only the initial event, nothing else
      expect(rawRumEvents).toHaveLength(1);
    });
  });

  describe('throttled view updates', () => {
    function notifyServerRumEvent(type: 'action' | 'error' | 'resource') {
      eventManager.notify({ kind: EventKind.SERVER, track: EventTrack.RUM, data: createServerRumEvent(type) });
    }

    it('collapses a burst into a leading and a trailing update', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

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
      viewCollection = new ViewCollection(eventManager, hooks);

      notifyServerRumEvent('resource');
      notifyServerRumEvent('error');
      notifyServerRumEvent('action');

      vi.advanceTimersByTime(VIEW_UPDATE_THROTTLE_DELAY);

      const trailing = rawRumEvents[rawRumEvents.length - 1].data as RawRumView;
      expect(trailing.view.resource.count).toBe(1);
      expect(trailing.view.error.count).toBe(1);
      expect(trailing.view.action.count).toBe(1);
      // initial=1, leading=2 (first resource), trailing=4 (after error+action increments)
      expect(trailing._dd.document_version).toBe(4);
    });

    it('session expired cancels pending trailing update', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

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
      viewCollection = new ViewCollection(eventManager, hooks);
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
      viewCollection = new ViewCollection(eventManager, hooks);

      notifyServerRumEvent('resource');
      notifyServerRumEvent('resource');

      viewCollection.stop();

      vi.advanceTimersByTime(VIEW_UPDATE_THROTTLE_DELAY);

      // initial + leading — no trailing after stop
      expect(rawRumEvents).toHaveLength(2);
    });
  });
});
