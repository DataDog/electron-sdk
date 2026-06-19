import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProfilingCollection } from './ProfilingCollection';
import { SKIPPED } from '@datadog/js-core/assembly';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack, LifecycleKind } from '../../event';
import type { RawProfileEvent, ServerProfileEvent, SessionRenewEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import type { FormatHooks } from '../../assembly';
import * as quotaCheckModule from './quotaCheck';

vi.mock('./quotaCheck');

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

  function makeSessionManager(status: 'active' | 'expired' = 'active', id = 'native-session-id') {
    return {
      getSession: () => ({ id, status }),
      // A profile is attributed to the session covering its capture time; an expired session has no
      // covering window in the history, so mirror that here by returning undefined.
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

    vi.mocked(quotaCheckModule.checkProfilingQuota).mockResolvedValue({ decision: 'quota_ok', reason: 'quota_ok' });
  });

  it('enriches event with native session.id and application.id', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config, hooks);

    eventManager.notify(makeRawProfileEvent());

    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0].data.session?.id).toBe('native-session-id');
    expect(serverEvents[0].data.application?.id).toBe('native-app-id');
  });

  it('preserves all other event fields unchanged', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config, hooks);
    const raw = makeRawProfileEvent({
      data: { application: { id: 'dummy' }, date: 9999, custom_field: 'preserved' } as never,
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

  it('drops profile when session is not active', () => {
    new ProfilingCollection(eventManager, makeSessionManager('expired'), config, hooks);

    eventManager.notify(makeRawProfileEvent());

    expect(serverEvents).toHaveLength(0);
  });

  it('emits ServerProfileEvent with correct kind and track', () => {
    new ProfilingCollection(eventManager, makeSessionManager(), config, hooks);

    eventManager.notify(makeRawProfileEvent());

    expect(serverEvents[0].kind).toBe(EventKind.SERVER);
    expect(serverEvents[0].track).toBe(EventTrack.PROFILE);
  });

  describe('capture-time attribution', () => {
    it('attributes the profile to the session covering its capture time, not the current one', () => {
      const sessionManager = {
        getSession: () => ({ id: 'current-session', status: 'active' as const }),
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
      const sessionManager = {
        getSession: () => ({ id: 'current-session', status: 'active' as const }),
        getTrackedSessionId: () => undefined,
      };
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

    it('forwards event when session is profiling-sampled', () => {
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(1);
    });

    it('discards event when session is not profiling-sampled', () => {
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

    it('redraws sampling decision on SESSION_RENEW with new session ID', () => {
      // Start with a non-sampled session, then renew to a sampled one
      const sessionManager = {
        getSession: vi
          .fn()
          .mockReturnValueOnce({ id: HIGH_HASH_UUID, status: 'active' as const }) // construction
          .mockReturnValue({ id: LOW_HASH_UUID, status: 'active' as const }), // SESSION_RENEW recompute
        // Capture-time attribution: the pre-renewal profile resolves to HIGH, the post-renewal one to LOW.
        getTrackedSessionId: vi.fn().mockReturnValueOnce(HIGH_HASH_UUID).mockReturnValue(LOW_HASH_UUID),
      };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 50 });
      new ProfilingCollection(eventManager, sessionManager, cfg, hooks);

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

  describe('quota check', () => {
    const LOW_HASH_UUID = '29a4b5e3-9859-4290-99fa-4bc4a1a348b9'; // passes sampling at rate 50
    const FIRST_UUID = '11111111-1111-4111-8111-111111111111';
    const SECOND_UUID = '22222222-2222-4222-8222-222222222222';

    it('forwards events while quota check is pending (optimistic)', () => {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      vi.mocked(quotaCheckModule.checkProfilingQuota).mockReturnValue(new Promise(() => {})); // never resolves
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(1);
    });

    it('discards events after quota_ko resolves', async () => {
      vi.mocked(quotaCheckModule.checkProfilingQuota).mockResolvedValue({
        decision: 'quota_ko',
        reason: 'quota_exceeded',
      });
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      await Promise.resolve(); // let the quota check microtask resolve

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(0);
    });

    it('forwards events after quota_ok resolves', async () => {
      vi.mocked(quotaCheckModule.checkProfilingQuota).mockResolvedValue({ decision: 'quota_ok', reason: 'quota_ok' });
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      await Promise.resolve();

      eventManager.notify(makeRawProfileEvent());

      expect(serverEvents).toHaveLength(1);
    });

    it('does not trigger quota check when session is not sampled', () => {
      vi.mocked(quotaCheckModule.checkProfilingQuota).mockResolvedValue({ decision: 'quota_ok', reason: 'quota_ok' });
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 0 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      expect(quotaCheckModule.checkProfilingQuota).not.toHaveBeenCalled();
    });

    it('re-triggers the quota check for the renewed session', async () => {
      // First session is denied; the renewed session is allowed.
      vi.mocked(quotaCheckModule.checkProfilingQuota)
        .mockResolvedValueOnce({ decision: 'quota_ko', reason: 'quota_exceeded' })
        .mockResolvedValueOnce({ decision: 'quota_ok', reason: 'quota_ok' });

      let currentId = FIRST_UUID;
      const sessionManager = {
        getSession: () => ({ id: currentId, status: 'active' as const }),
        getTrackedSessionId: () => currentId,
      };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, sessionManager, cfg, hooks);

      await Promise.resolve(); // first session's quota_ko resolves

      eventManager.notify(makeRawProfileEvent());
      expect(serverEvents).toHaveLength(0); // first session denied

      currentId = SECOND_UUID; // session renews
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await Promise.resolve(); // renewed session's quota_ok resolves

      eventManager.notify(makeRawProfileEvent());
      expect(serverEvents).toHaveLength(1); // renewed session allowed
    });

    it('drops a profile from a denied session even after renewal to an allowed one', async () => {
      // The captured session (FIRST) is denied; a later renewal to an allowed session must not revive it.
      vi.mocked(quotaCheckModule.checkProfilingQuota)
        .mockResolvedValueOnce({ decision: 'quota_ko', reason: 'quota_exceeded' })
        .mockResolvedValueOnce({ decision: 'quota_ok', reason: 'quota_ok' });

      let currentId = FIRST_UUID;
      const sessionManager = {
        getSession: () => ({ id: currentId, status: 'active' as const }),
        getTrackedSessionId: () => FIRST_UUID, // the profile was captured during the denied session
      };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, sessionManager, cfg, hooks);

      await Promise.resolve(); // FIRST denied

      currentId = SECOND_UUID; // session renews to an allowed one
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await Promise.resolve(); // SECOND allowed

      eventManager.notify(makeRawProfileEvent());
      expect(serverEvents).toHaveLength(0); // captured session was denied
    });

    it('forwards a profile from an allowed session even when the current session is denied', async () => {
      // The captured session (FIRST) is allowed; a later denied session must not drop it.
      vi.mocked(quotaCheckModule.checkProfilingQuota)
        .mockResolvedValueOnce({ decision: 'quota_ok', reason: 'quota_ok' })
        .mockResolvedValueOnce({ decision: 'quota_ko', reason: 'quota_exceeded' });

      let currentId = FIRST_UUID;
      const sessionManager = {
        getSession: () => ({ id: currentId, status: 'active' as const }),
        getTrackedSessionId: () => FIRST_UUID, // the profile was captured during the allowed session
      };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });
      new ProfilingCollection(eventManager, sessionManager, cfg, hooks);

      await Promise.resolve(); // FIRST allowed

      currentId = SECOND_UUID; // session renews to a denied one
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await Promise.resolve(); // SECOND denied

      eventManager.notify(makeRawProfileEvent());
      expect(serverEvents).toHaveLength(1); // captured session was allowed
    });

    it('does not trigger quota check on SESSION_RENEW when not sampled', () => {
      vi.mocked(quotaCheckModule.checkProfilingQuota).mockResolvedValue({ decision: 'quota_ok', reason: 'quota_ok' });
      const sessionManager = {
        getSession: vi.fn().mockReturnValue({ id: LOW_HASH_UUID, status: 'active' as const }),
        getTrackedSessionId: () => LOW_HASH_UUID,
      };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 0 });
      new ProfilingCollection(eventManager, sessionManager, cfg, hooks);

      const renewEvent: SessionRenewEvent = { kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW };
      eventManager.notify(renewEvent);

      expect(quotaCheckModule.checkProfilingQuota).not.toHaveBeenCalled();
    });
  });

  describe('profiling context (renderer RUM enrichment)', () => {
    const LOW_HASH_UUID = '29a4b5e3-9859-4290-99fa-4bc4a1a348b9';
    const sampledCfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 100 });

    function invokeHook(source: EventSource, eventType: string) {
      const cb = vi.mocked(hooks.registerRum).mock.calls[0][0];
      return cb({ source, eventType, startTime: 0 } as unknown as Parameters<RumHookCallback>[0]);
    }

    it('contributes stopped status and quota_reason on quota_ko for renderer view events', async () => {
      vi.mocked(quotaCheckModule.checkProfilingQuota).mockResolvedValue({
        decision: 'quota_ko',
        reason: 'quota_exceeded',
      });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), sampledCfg, hooks);
      await Promise.resolve();

      expect(invokeHook(EventSource.RENDERER, 'view')).toEqual({
        _dd: { profiling: { status: 'stopped', quota_reason: 'quota_exceeded' } },
      });
    });

    it('suppresses the context with null when the session is sampled out', () => {
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 0 });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), cfg, hooks);

      expect(invokeHook(EventSource.RENDERER, 'view')).toEqual({ _dd: { profiling: null } });
    });

    it('contributes nothing while quota is pending or ok', () => {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      vi.mocked(quotaCheckModule.checkProfilingQuota).mockReturnValue(new Promise(() => {}));
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), sampledCfg, hooks);

      expect(invokeHook(EventSource.RENDERER, 'view')).toBe(SKIPPED);
    });

    it('contributes nothing for main-process events', async () => {
      vi.mocked(quotaCheckModule.checkProfilingQuota).mockResolvedValue({
        decision: 'quota_ko',
        reason: 'quota_exceeded',
      });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), sampledCfg, hooks);
      await Promise.resolve();

      expect(invokeHook(EventSource.MAIN, 'view')).toBe(SKIPPED);
    });

    it('only contributes to view/long_task/action/vital event types', async () => {
      vi.mocked(quotaCheckModule.checkProfilingQuota).mockResolvedValue({
        decision: 'quota_ko',
        reason: 'quota_exceeded',
      });
      new ProfilingCollection(eventManager, makeSessionManager('active', LOW_HASH_UUID), sampledCfg, hooks);
      await Promise.resolve();

      expect(invokeHook(EventSource.RENDERER, 'resource')).toBe(SKIPPED);
      expect(invokeHook(EventSource.RENDERER, 'error')).toBe(SKIPPED);
      expect(invokeHook(EventSource.RENDERER, 'long_task')).toEqual({
        _dd: { profiling: { status: 'stopped', quota_reason: 'quota_exceeded' } },
      });
    });

    it('resolves the context from the event start time, not the current session', () => {
      const HIGH_HASH_UUID = '5321b54a-d6ec-4b24-996d-dd70c617e09a'; // sampled out at rate 50
      // Current session (LOW) is profiling-sampled, but the event was captured during a sampled-out session.
      const sessionManager = {
        getSession: () => ({ id: LOW_HASH_UUID, status: 'active' as const }),
        getTrackedSessionId: vi.fn().mockReturnValue(HIGH_HASH_UUID),
      };
      const cfg = createTestConfiguration({ sessionSampleRate: 100, profilingSampleRate: 50 });
      new ProfilingCollection(eventManager, sessionManager, cfg, hooks);

      // Suppressed (HIGH is sampled out) even though the current session would be sampled.
      expect(invokeHook(EventSource.RENDERER, 'view')).toEqual({ _dd: { profiling: null } });
    });

    it('contributes nothing when no session covers the event start time', () => {
      const sessionManager = {
        getSession: () => ({ id: LOW_HASH_UUID, status: 'active' as const }),
        getTrackedSessionId: () => undefined,
      };
      new ProfilingCollection(eventManager, sessionManager, sampledCfg, hooks);

      expect(invokeHook(EventSource.RENDERER, 'view')).toBe(SKIPPED);
    });

    it('stops contributing quota_reason after the session renews to an allowed one', async () => {
      vi.mocked(quotaCheckModule.checkProfilingQuota)
        .mockResolvedValueOnce({ decision: 'quota_ko', reason: 'quota_exceeded' })
        .mockResolvedValueOnce({ decision: 'quota_ok', reason: 'quota_ok' });
      let currentId = LOW_HASH_UUID;
      const sessionManager = {
        getSession: () => ({ id: currentId, status: 'active' as const }),
        getTrackedSessionId: () => currentId,
      };
      new ProfilingCollection(eventManager, sessionManager, sampledCfg, hooks);
      await Promise.resolve();
      expect(invokeHook(EventSource.RENDERER, 'view')).toEqual({
        _dd: { profiling: { status: 'stopped', quota_reason: 'quota_exceeded' } },
      });

      currentId = '33333333-3333-4333-8333-333333333333'; // session renews to an allowed one
      eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });
      await Promise.resolve();

      expect(invokeHook(EventSource.RENDERER, 'view')).toBe(SKIPPED);
    });
  });
});
