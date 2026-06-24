import { beforeEach, describe, it, expect } from 'vitest';
import { type TimeStamp } from '@datadog/js-core/time';
import { DISCARDED } from '@datadog/js-core/assembly';
import { MainAssembly } from './MainAssembly';
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
    serverEvents = [];

    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => serverEvents.push(event),
    });

    new MainAssembly(eventManager, hooks);
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

  describe('TELEMETRY events', () => {
    it('emits ServerTelemetryEvent with source MAIN', () => {
      hooks.registerTelemetry(() => ({}));

      notifyRawTelemetryEvent();

      expect(serverEvents).toHaveLength(1);
      expect((serverEvents[0] as ServerTelemetryEvent).source).toBe(EventSource.MAIN);
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
