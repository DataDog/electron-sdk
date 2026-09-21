import { beforeEach, describe, it, expect, vi } from 'vitest';
import { toServerDuration, type Duration, type TimeStamp } from '@datadog/js-core/time';
import { DISCARDED } from '@datadog/js-core/assembly';
import { MainAssembly } from './MainAssembly';
import { BeforeSend } from './BeforeSend';
import { createFormatHooks, type FormatHooks } from './hooks';
import {
  EventFormat,
  EventKind,
  EventManager,
  EventSource,
  type RawRumEvent,
  type RawTelemetryEvent,
  type ServerEvent,
  type ServerRumEvent,
  type ServerTelemetryEvent,
} from '../event';
import type { RumEvent, RawRumData } from '../domain/rum';
import type { RawTelemetryData } from '../domain/telemetry';
import { createTrackingConsentState, type TrackingConsentState } from '../domain/tracking-consent';

const RAW_ERROR_DATA: RawRumData = {
  type: 'error',
  error: { id: '1', message: 'test', source: 'custom', handling: 'handled' },
};

const RAW_TELEMETRY_DATA: RawTelemetryData = {
  type: 'telemetry',
  telemetry: { type: 'log', status: 'error', message: 'sdk error' },
};

describe('MainAssembly', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let beforeSend: BeforeSend;
  let trackingConsentState: TrackingConsentState;
  let serverEvents: ServerEvent[];

  function notifyRawRumEvent(overrides?: Partial<RawRumEvent>) {
    eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data: RAW_ERROR_DATA,
      ...overrides,
    });
  }

  function notifyRawTelemetryEvent(overrides?: Partial<RawTelemetryEvent>) {
    eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.TELEMETRY,
      data: RAW_TELEMETRY_DATA,
      ...overrides,
    });
  }

  beforeEach(() => {
    eventManager = new EventManager();
    hooks = createFormatHooks();
    beforeSend = new BeforeSend();
    trackingConsentState = createTrackingConsentState('granted');
    serverEvents = [];

    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => serverEvents.push(event),
    });

    new MainAssembly(eventManager, hooks, beforeSend, trackingConsentState);
  });

  it('favors raw event attributes over hook attributes', () => {
    hooks.registerRum(() => ({ date: 999, session: { id: 'hook-session' } }));

    notifyRawRumEvent({ data: { ...RAW_ERROR_DATA, date: 1234567890 } });

    expect(serverEvents).toHaveLength(1);
    const rumEvent = serverEvents[0].data as RumEvent;
    expect(rumEvent.date).toBe(1234567890);
    expect(rumEvent.session.id).toBe('hook-session');
  });

  it('uses hook attributes when raw event does not provide them', () => {
    hooks.registerRum(() => ({ date: 999, session: { id: 'hook-session' } }));

    notifyRawRumEvent();

    expect(serverEvents).toHaveLength(1);
    const rumEvent = serverEvents[0].data as RumEvent;
    expect(rumEvent.date).toBe(999);
    expect(rumEvent.session.id).toBe('hook-session');
  });

  it('discards events when hook returns DISCARDED', () => {
    hooks.registerRum(() => DISCARDED);

    notifyRawRumEvent();

    expect(serverEvents).toHaveLength(0);
  });

  it('passes startTime from raw event to hooks', () => {
    hooks.registerRum((params) => ({ date: params.startTime }));

    notifyRawRumEvent({ startTime: 42 as TimeStamp });

    expect(serverEvents).toHaveLength(1);
    const rumEvent = serverEvents[0].data as RumEvent;
    expect(rumEvent.date).toBe(42);
  });

  it('emits ServerRumEvent with source MAIN', () => {
    hooks.registerRum(() => ({}));

    notifyRawRumEvent();

    expect((serverEvents[0] as ServerRumEvent).source).toBe(EventSource.MAIN);
  });

  it('marks view updates with their assembly time for consent routing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    hooks.registerRum(() => ({ session: { id: 'session' } }));

    notifyRawRumEvent({
      startTime: 10 as TimeStamp,
      data: {
        type: 'view',
        view: {
          id: 'view',
          time_spent: toServerDuration(1 as Duration),
          is_active: true,
          action: { count: 0 },
          error: { count: 0 },
          resource: { count: 0 },
        },
        _dd: { document_version: 1 },
      },
    });

    expect(serverEvents[0].consentTime).toBe(100);
    vi.useRealTimers();
  });

  it('marks completed duration vitals with their stop time for consent routing', () => {
    hooks.registerRum(() => ({ session: { id: 'session' } }));

    notifyRawRumEvent({
      startTime: 10 as TimeStamp,
      data: {
        type: 'vital',
        date: 10 as TimeStamp,
        vital: {
          id: 'vital',
          name: 'startup',
          type: 'duration',
          duration: toServerDuration(20 as Duration),
        },
      },
    });

    expect(serverEvents[0].consentTime).toBe(30);
  });

  it('applies beforeSendRum to fully assembled RUM events after hooks', () => {
    hooks.registerRum(() => ({ session: { id: 'hook-session' } }));
    const applySpy = vi.spyOn(beforeSend, 'apply').mockImplementation((event) => {
      expect(event.session.id).toBe('hook-session');
      if (event.type === 'error') {
        event.error.message = 'modified';
      }
      return event;
    });

    notifyRawRumEvent();

    expect(applySpy).toHaveBeenCalledWith(expect.any(Object), 'main');
    expect(serverEvents[0].data).toMatchObject({ error: { message: 'modified' } });
  });

  it('does not emit RUM events discarded by beforeSendRum', () => {
    hooks.registerRum(() => ({}));
    vi.spyOn(beforeSend, 'apply').mockReturnValue(undefined);

    notifyRawRumEvent();

    expect(serverEvents).toHaveLength(0);
  });

  it('does not reauthorize a rejected pending event when beforeSendRum grants in the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    trackingConsentState.update('pending');
    hooks.registerRum(() => ({ session: { id: 'session' } }));
    vi.spyOn(beforeSend, 'apply').mockImplementation((event) => {
      trackingConsentState.update('not-granted');
      trackingConsentState.update('granted');
      return event;
    });

    notifyRawRumEvent();

    expect(serverEvents).toHaveLength(0);
    vi.useRealTimers();
  });

  it('preserves a precomputed granted decision when assembly happens after revocation', () => {
    hooks.registerRum(() => ({ session: { id: 'session' } }));
    trackingConsentState.update('not-granted');

    notifyRawRumEvent({
      startTime: 10 as TimeStamp,
      consentTime: 20,
      storageConsent: 'granted',
    });

    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0].storageConsent).toBe('granted');
  });

  describe('TELEMETRY events', () => {
    it('emits ServerTelemetryEvent with source MAIN', () => {
      hooks.registerTelemetry(() => ({}));
      const applySpy = vi.spyOn(beforeSend, 'apply');

      notifyRawTelemetryEvent();

      expect(serverEvents).toHaveLength(1);
      expect((serverEvents[0] as ServerTelemetryEvent).source).toBe(EventSource.MAIN);
      expect(applySpy).not.toHaveBeenCalled();
    });

    it('discards telemetry events when hook returns DISCARDED', () => {
      hooks.registerTelemetry(() => DISCARDED);

      notifyRawTelemetryEvent();

      expect(serverEvents).toHaveLength(0);
    });

    it('passes startTime from raw event to telemetry hook', () => {
      hooks.registerTelemetry((params) => ({ date: params.startTime }));

      notifyRawTelemetryEvent({ startTime: 42 as TimeStamp });

      expect(serverEvents).toHaveLength(1);
      expect(serverEvents[0].data).toMatchObject({ date: 42 });
    });
  });
});
