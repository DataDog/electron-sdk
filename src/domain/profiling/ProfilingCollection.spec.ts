import { describe, it, expect, beforeEach } from 'vitest';
import { ProfilingCollection } from './ProfilingCollection';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack } from '../../event';
import type { RawProfileEvent, ServerProfileEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';

function makeRawProfileEvent(overrides: Partial<RawProfileEvent> = {}): RawProfileEvent {
  return {
    kind: EventKind.RAW,
    source: EventSource.RENDERER,
    format: EventFormat.PROFILE,
    data: { application: { id: 'browser-dummy-app-id' }, date: 1234567890 },
    trace: { resources: [], frames: [], stacks: [], samples: [] },
    ...overrides,
  } as RawProfileEvent;
}

describe('ProfilingCollection', () => {
  let eventManager: EventManager;
  let serverEvents: ServerProfileEvent[];
  const config = createTestConfiguration({ applicationId: 'native-app-id' });

  function makeSessionManager(status: 'active' | 'expired' = 'active') {
    return {
      getSession: () => ({ id: 'native-session-id', status }),
    };
  }

  beforeEach(() => {
    eventManager = new EventManager();
    serverEvents = [];

    eventManager.registerHandler<ServerProfileEvent>({
      canHandle: (event): event is ServerProfileEvent =>
        event.kind === EventKind.SERVER && event.track === EventTrack.PROFILE,
      handle: (event) => serverEvents.push(event),
    });
  });

  it('enriches event with native session.id and application.id', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config);

    eventManager.notify(makeRawProfileEvent());

    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0].data.session?.id).toBe('native-session-id');
    expect(serverEvents[0].data.application?.id).toBe('native-app-id');
  });

  it('preserves all other event fields unchanged', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config);
    const raw = makeRawProfileEvent({
      data: { application: { id: 'dummy' }, date: 9999, custom_field: 'preserved' } as never,
    });

    eventManager.notify(raw);

    expect(serverEvents[0].data.date).toBe(9999);
    expect((serverEvents[0].data as Record<string, unknown>).custom_field).toBe('preserved');
  });

  it('passes trace through unchanged', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config);
    const trace = {
      resources: ['r1'],
      frames: [{ name: 'f1' }],
      stacks: [{ frameId: 0 }],
      samples: [{ stackId: 0, timestamp: 1 }],
    };

    eventManager.notify(makeRawProfileEvent({ trace: trace as never }));

    expect(serverEvents[0].trace).toBe(trace);
  });

  it('drops profile when session is not active', () => {
    new ProfilingCollection(eventManager, makeSessionManager('expired'), config);

    eventManager.notify(makeRawProfileEvent());

    expect(serverEvents).toHaveLength(0);
  });

  it('emits ServerProfileEvent with correct kind and track', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config);

    eventManager.notify(makeRawProfileEvent());

    expect(serverEvents[0].kind).toBe(EventKind.SERVER);
    expect(serverEvents[0].track).toBe(EventTrack.PROFILE);
  });
});
