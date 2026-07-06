import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProfilingCollection } from './ProfilingCollection';
import { SKIPPED } from '@datadog/js-core/assembly';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack } from '../../event';
import type { RawProfileEvent, ServerProfileEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import type { FormatHooks } from '../../assembly';

type RumHookCallback = Parameters<FormatHooks['registerRum']>[0];

function makeRawProfileEvent(overrides: Partial<RawProfileEvent> = {}): RawProfileEvent {
  return {
    kind: EventKind.RAW,
    source: EventSource.RENDERER,
    format: EventFormat.PROFILE,
    data: { application: { id: 'browser-dummy-app-id' }, date: 1234567890, start: '2024-06-01T00:00:00.000Z' },
    trace: { resources: [], frames: [], stacks: [], samples: [] },
    ...overrides,
  } as RawProfileEvent;
}

describe('ProfilingCollection', () => {
  let eventManager: EventManager;
  let serverEvents: ServerProfileEvent[];
  let hooks: FormatHooks;
  const config = createTestConfiguration({ applicationId: 'native-app-id' });

  // A profile is attributed to the session covering its capture time; an expired session has no covering
  // window in the history, so mirror that here by returning undefined.
  function makeSessionManager(status: 'active' | 'expired' = 'active', id = 'native-session-id') {
    return {
      getTrackedSessionId: () => (status === 'active' ? id : undefined),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    serverEvents = [];
    hooks = {
      registerRum: vi.fn(),
      registerTelemetry: vi.fn(),
      registerSpan: vi.fn(),
      triggerRum: vi.fn(),
      triggerTelemetry: vi.fn(),
      triggerSpan: vi.fn(),
    };

    eventManager.registerHandler<ServerProfileEvent>({
      canHandle: (event): event is ServerProfileEvent =>
        event.kind === EventKind.SERVER && event.track === EventTrack.PROFILE,
      handle: (event) => serverEvents.push(event),
    });
  });

  it('enriches event with the resolved session.id and application.id', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config, hooks);

    eventManager.notify(makeRawProfileEvent());

    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0].data.session?.id).toBe('native-session-id');
    expect(serverEvents[0].data.application?.id).toBe('native-app-id');
  });

  it('preserves all other event fields unchanged', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config, hooks);
    const raw = makeRawProfileEvent({
      data: {
        application: { id: 'dummy' },
        date: 9999,
        start: '2024-06-01T00:00:00.000Z',
        custom_field: 'preserved',
      } as never,
    });

    eventManager.notify(raw);

    expect(serverEvents[0].data.date).toBe(9999);
    expect((serverEvents[0].data as Record<string, unknown>).custom_field).toBe('preserved');
  });

  it('passes trace through unchanged', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config, hooks);
    const trace = {
      resources: ['r1'],
      frames: [{ name: 'f1' }],
      stacks: [{ frameId: 0 }],
      samples: [{ stackId: 0, timestamp: 1 }],
    };

    eventManager.notify(makeRawProfileEvent({ trace: trace as never }));

    expect(serverEvents[0].trace).toBe(trace);
  });

  it('emits ServerProfileEvent with correct kind and track', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config, hooks);

    eventManager.notify(makeRawProfileEvent());

    expect(serverEvents[0].kind).toBe(EventKind.SERVER);
    expect(serverEvents[0].track).toBe(EventTrack.PROFILE);
  });

  describe('capture-time attribution', () => {
    it('attributes the profile to the session covering its capture time', () => {
      const sessionManager = {
        getTrackedSessionId: vi.fn().mockReturnValue('capture-session'),
      };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, sessionManager, cfg, hooks);

      eventManager.notify(
        makeRawProfileEvent({
          data: { application: { id: 'browser-dummy-app-id' }, start: '1970-01-01T00:00:05.000Z' } as never,
        })
      );

      expect(sessionManager.getTrackedSessionId).toHaveBeenCalledWith(5000);
      expect(serverEvents[0].data.session?.id).toBe('capture-session');
    });

    it('drops the profile when no tracked session covers the capture time', () => {
      const sessionManager = { getTrackedSessionId: () => undefined };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, sessionManager, cfg, hooks);

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(0);
    });
  });

  describe('profilingSampleRate sampling', () => {
    // LOW_HASH_UUID passes isSessionSampled at low rates; HIGH_HASH_UUID does not
    const LOW_HASH_UUID = '29a4b5e3-9859-4290-99fa-4bc4a1a348b9';
    const HIGH_HASH_UUID = '5321b54a-d6ec-4b24-996d-dd70c617e09a';

    it('forwards event when the resolved session is profiling-sampled', () => {
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(1);
    });

    it('discards event when the resolved session is not profiling-sampled', () => {
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 0 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(0);
    });

    it('uses correctedChildSampleRate: high-hash UUID is not sampled at correctedRate below its hash', () => {
      // HIGH_HASH_UUID has a hash ~99.9%. correctedChildSampleRate(100, 50) = 50 → not sampled.
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 50 });
      new ProfilingCollection(eventManager, makeSessionManager('active', HIGH_HASH_UUID), cfg, hooks);

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(0);
    });
  });

  describe('profiling context (renderer RUM enrichment)', () => {
    const LOW_HASH_UUID = '29a4b5e3-9859-4290-99fa-4bc4a1a348b9';
    const sampledCfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });

    function invokeHook(source: EventSource, eventType: string) {
      const cb = vi.mocked(hooks.registerRum).mock.calls[0][0];
      return cb({ source, eventType, startTime: 0 } as unknown as Parameters<RumHookCallback>[0]);
    }

    it('suppresses the context with null when the session is sampled out', () => {
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 0 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      expect(invokeHook(EventSource.RENDERER, 'view')).toEqual({ _dd: { profiling: null } });
    });

    it('contributes nothing for a sampled session', () => {
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), sampledCfg, hooks);

      expect(invokeHook(EventSource.RENDERER, 'view')).toBe(SKIPPED);
    });

    it('contributes nothing for main-process events', () => {
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), sampledCfg, hooks);

      expect(invokeHook(EventSource.MAIN, 'view')).toBe(SKIPPED);
    });

    it('only contributes to view/long_task/action/vital event types', () => {
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 0 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      expect(invokeHook(EventSource.RENDERER, 'resource')).toBe(SKIPPED);
      expect(invokeHook(EventSource.RENDERER, 'error')).toBe(SKIPPED);
      expect(invokeHook(EventSource.RENDERER, 'long_task')).toEqual({ _dd: { profiling: null } });
    });

    it('resolves the context from the event start time, not the current session', () => {
      const HIGH_HASH_UUID = '5321b54a-d6ec-4b24-996d-dd70c617e09a'; // sampled out at rate 50
      const sessionManager = {
        getTrackedSessionId: vi.fn().mockReturnValue(HIGH_HASH_UUID),
      };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 50 });
      new ProfilingCollection(eventManager, sessionManager, cfg, hooks);

      // Suppressed (HIGH is sampled out) — the decision comes from the resolved session, not the current one.
      expect(invokeHook(EventSource.RENDERER, 'view')).toEqual({ _dd: { profiling: null } });
    });

    it('contributes nothing when no session covers the event start time', () => {
      const sessionManager = { getTrackedSessionId: () => undefined };
      new ProfilingCollection(eventManager, sessionManager, sampledCfg, hooks);

      expect(invokeHook(EventSource.RENDERER, 'view')).toBe(SKIPPED);
    });
  });
});
