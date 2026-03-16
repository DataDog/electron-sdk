import { beforeEach, describe, it, expect } from 'vitest';
import { DISCARDED, type TimeStamp } from '@datadog/browser-core';
import { Assembly } from './Assembly';
import { createFormatHooks, type FormatHooks } from './hooks';
import { registerCommonContext } from './commonContext';
import {
  EventFormat,
  EventKind,
  EventManager,
  EventSource,
  EventTrack,
  type RawRumEvent,
  type ServerEvent,
} from '../event';
import type { RumEvent, RawRumData } from '../domain/rum';
import { createTestConfiguration } from '../mocks.specUtil';

const RAW_ERROR_DATA: RawRumData = {
  type: 'error',
  error: { id: '1', message: 'test', source: 'custom', handling: 'handled' },
};

describe('Assembly', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let serverEvents: ServerEvent[];

  function notifyRawRumEvent(overrides?: Partial<RawRumEvent>) {
    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: RAW_ERROR_DATA,
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

    new Assembly(eventManager, hooks);
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
});

describe('Assembly — renderer events', () => {
  function setup() {
    const config = createTestConfiguration({ applicationId: 'main-app-id', service: 'main-service' });
    const eventManager = new EventManager();
    const hooks = createFormatHooks();

    registerCommonContext(config, hooks);
    hooks.registerRum(() => ({ session: { id: 'main-session-id' } }));

    new Assembly(eventManager, hooks);
    return { eventManager };
  }

  it('should only override session.id and application.id', () => {
    const { eventManager } = setup();
    const collected: ServerEvent[] = [];
    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => collected.push(event),
    });

    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.RENDERER,
      format: EventFormat.RUM,
      data: {
        type: 'view',
        source: 'browser',
        service: 'renderer-service',
        application: { id: 'renderer-app-id' },
        session: { id: 'renderer-session-id', type: 'user' },
        view: { id: 'renderer-view-id', name: 'renderer-view', url: 'http://localhost' },
        ddtags: 'sdk_version:1.0.0',
      },
    } as unknown as RawRumEvent);

    expect(collected).toHaveLength(1);
    const data = collected[0].data as RumEvent;

    // Overridden by main process
    expect(data.session.id).toBe('main-session-id');
    expect(data.application.id).toBe('main-app-id');

    // Preserved from renderer
    expect(data.source).toBe('browser');
    expect(data.service).toBe('renderer-service');
    expect(data.view.id).toBe('renderer-view-id');
    expect(data.view.name).toBe('renderer-view');
    expect(data.ddtags).toBe('sdk_version:1.0.0');
  });

  it('should preserve renderer view attributes', () => {
    const { eventManager } = setup();
    const collected: ServerEvent[] = [];
    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => collected.push(event),
    });

    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.RENDERER,
      format: EventFormat.RUM,
      data: {
        type: 'error',
        source: 'browser',
        error: { message: 'renderer error', source: 'source' },
        view: { id: 'renderer-view-456' },
        session: { id: 'will-be-overridden' },
        application: { id: 'will-be-overridden' },
      },
    } as unknown as RawRumEvent);

    expect(collected).toHaveLength(1);
    const data = collected[0].data as RumEvent;
    expect(data.session.id).toBe('main-session-id');
    expect(data.application.id).toBe('main-app-id');
    expect(data.view.id).toBe('renderer-view-456');
    expect(collected[0].track).toBe(EventTrack.RUM);
  });
});
