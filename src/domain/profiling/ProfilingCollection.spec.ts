import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProfilingCollection } from './ProfilingCollection';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack, LifecycleKind } from '../../event';
import type { RawProfileEvent, ServerProfileEvent, SessionRenewEvent } from '../../event';
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

  function makeSessionManager(status: 'active' | 'expired' = 'active', id = 'native-session-id') {
    return {
      getSession: () => ({ id, status }),
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

  describe('profilingSampleRate sampling', () => {
    // LOW_HASH_UUID passes isSessionSampled at low rates; HIGH_HASH_UUID does not
    const LOW_HASH_UUID = '29a4b5e3-9859-4290-99fa-4bc4a1a348b9';
    const HIGH_HASH_UUID = '5321b54a-d6ec-4b24-996d-dd70c617e09a';

    it('forwards event when session is profiling-sampled', () => {
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg);

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(1);
    });

    it('discards event when session is not profiling-sampled', () => {
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 0 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg);

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(0);
    });

    it('uses correctedChildSampleRate: high-hash UUID is not sampled at correctedRate below its hash', () => {
      // HIGH_HASH_UUID has a hash ~99.9%. correctedChildSampleRate(100, 50) = 50 → not sampled.
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 50 });
      new ProfilingCollection(eventManager, makeSessionManager('active', HIGH_HASH_UUID), cfg);

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(0);
    });

    it('redraws sampling decision on SESSION_RENEW with new session ID', () => {
      // Start with a non-sampled session, then renew to a sampled one
      const sessionManager = {
        getSession: vi
          .fn()
          .mockReturnValueOnce({ id: HIGH_HASH_UUID, status: 'active' as const }) // construction
          .mockReturnValueOnce({ id: LOW_HASH_UUID, status: 'active' as const }) // SESSION_RENEW
          .mockReturnValue({ id: LOW_HASH_UUID, status: 'active' as const }), // enrich calls
      };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 50 });
      new ProfilingCollection(eventManager, sessionManager, cfg);

      // Before renewal: HIGH_HASH_UUID is not sampled at rate 50
      eventManager.notify(makeRawProfileEvent());
      expect(serverEvents).toHaveLength(0);

      // Trigger session renewal
      const renewEvent: SessionRenewEvent = { kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW };
      eventManager.notify(renewEvent);

      // After renewal: LOW_HASH_UUID is sampled at rate 50
      eventManager.notify(makeRawProfileEvent());
      expect(serverEvents).toHaveLength(1);
    });
  });
});
