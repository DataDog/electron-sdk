import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type TimeStamp } from '@datadog/js-core/time';
import { DISCARDED } from '@datadog/js-core/assembly';
import { RendererPipeline } from './RendererPipeline';
import type { BridgeOptions } from '../common';
import { createFormatHooks, type FormatHooks } from './hooks';
import {
  EventFormat,
  EventKind,
  EventManager,
  EventSource,
  EventTrack,
  LifecycleKind,
  type BrowserProfileEvent,
  type BrowserProfilerTrace,
  type EndUserActivityEvent,
  type RawProfileEvent,
  type RawReplayEvent,
  type ServerRumEvent,
  type ServerTelemetryEvent,
} from '../event';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';
import type { RumBeforeSend } from '../config';
import { createMockSender, createTestConfiguration, type MockSender } from '../mocks.specUtil';
import { registerCommonContext } from './commonContext';

const { mockIpcMainOn, mockAddError, mockSetBridgeConfig } = vi.hoisted(() => {
  const mockIpcMainOn = vi.fn();
  const mockAddError = vi.fn();
  const mockSetBridgeConfig = vi.fn();
  return { mockIpcMainOn, mockAddError, mockSetBridgeConfig };
});

vi.mock('electron', () => ({
  ipcMain: { on: mockIpcMainOn },
}));

vi.mock('../domain/telemetry', () => ({
  monitor: (fn: () => void) => fn,
  addError: mockAddError,
}));

vi.mock('../common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common')>();
  return { ...actual, setBridgeConfig: mockSetBridgeConfig };
});

const DEFAULT_CONFIG = createTestConfiguration({ profilingSampleRate: 0 });

const RENDERER_RUM_DATA = {
  type: 'view',
  date: 12345 as TimeStamp,
  source: 'browser',
  service: 'renderer-service',
  application: { id: 'renderer-app-id' },
  session: { id: 'renderer-session-id', type: 'user' },
  view: { id: 'renderer-view-id', name: 'My View', url: 'http://localhost' },
  ddtags: 'sdk_version:1.0.0',
  _dd: { configuration: { trace_sample_rate: 80 } },
};

const RENDERER_CLICK_DATA = {
  type: 'action',
  date: 12345 as TimeStamp,
  source: 'browser',
  service: 'renderer-service',
  application: { id: 'renderer-app-id' },
  session: { id: 'renderer-session-id', type: 'user' },
  view: { id: 'renderer-view-id', name: 'My View', url: 'http://localhost' },
  action: {
    id: 'action-id',
    type: 'click',
    target: { name: 'button' },
    loading_time: 0,
    error: { count: 0 },
    crash: { count: 0 },
    long_task: { count: 0 },
    resource: { count: 0 },
  },
  ddtags: 'sdk_version:1.0.0',
};

/**
 * A telemetry event as the renderer's browser RUM SDK assembles it before sending it over the bridge,
 * already carrying its own service/source/version/date and the view it belongs to.
 */
const RENDERER_TELEMETRY_DATA = {
  type: 'telemetry',
  date: 12345 as TimeStamp,
  source: 'browser',
  service: 'browser-rum-sdk',
  version: '6.0.0',
  application: { id: 'renderer-app-id' },
  session: { id: 'renderer-session-id' },
  view: { id: 'renderer-view-id' },
  ddtags: 'sdk_version:6.0.0,service:renderer-service',
  _dd: { format_version: 2 },
  telemetry: { type: 'log', status: 'error', message: 'renderer failure' },
};

interface IpcMessageExtra {
  /** Pass `null` to simulate a destroyed/navigated frame (senderFrame === null). */
  senderFrame?: null;
  processId?: number;
  frameId?: number;
  sender?: MockSender;
}

describe('RendererPipeline', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let simulateIpcMessage: (msg: string, origin?: string, url?: string, extra?: IpcMessageExtra) => void;
  let serverEvents: ServerRumEvent[];
  let telemetryEvents: ServerTelemetryEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    hooks = createFormatHooks();
    serverEvents = [];
    telemetryEvents = [];

    mockIpcMainOn.mockImplementation(
      (
        channel: string,
        callback: (
          event: {
            senderFrame: { origin: string; url?: string } | null;
            processId: number;
            frameId: number;
            sender: {
              once: (event: string, cb: () => void) => void;
              on: (event: string, cb: (...args: unknown[]) => void) => void;
              off: (event: string, cb: (...args: unknown[]) => void) => void;
            };
          },
          msg: string
        ) => void
      ) => {
        if (channel === BRIDGE_CHANNEL) {
          simulateIpcMessage = (
            msg: string,
            origin = 'https://any.example.com',
            url?: string,
            extra?: IpcMessageExtra
          ) =>
            callback(
              {
                senderFrame: extra?.senderFrame === null ? null : { origin, url },
                processId: extra?.processId ?? 1,
                frameId: extra?.frameId ?? 1,
                sender: extra?.sender ?? createMockSender(),
              },
              msg
            );
        }
      }
    );

    // Telemetry shares the RUM track, so the two collectors split on the event type the way the
    // intake does.
    eventManager.registerHandler<ServerRumEvent>({
      canHandle: (event): event is ServerRumEvent =>
        event.kind === EventKind.SERVER && event.track === EventTrack.RUM && event.data.type !== 'telemetry',
      handle: (event) => serverEvents.push(event),
    });

    eventManager.registerHandler<ServerTelemetryEvent>({
      canHandle: (event): event is ServerTelemetryEvent =>
        event.kind === EventKind.SERVER && event.track === EventTrack.RUM && event.data.type === 'telemetry',
      handle: (event) => telemetryEvents.push(event),
    });

    new RendererPipeline(eventManager, hooks, DEFAULT_CONFIG);
  });

  it('registers a listener on BRIDGE_CHANNEL', () => {
    expect(mockIpcMainOn).toHaveBeenCalledWith(BRIDGE_CHANNEL, expect.any(Function));
  });

  it('does NOT register a listener on CONFIG_CHANNEL (responder lives in instrument)', () => {
    const channels = mockIpcMainOn.mock.calls.map((call) => call[0] as string);
    expect(channels).not.toContain(CONFIG_CHANNEL);
  });

  it('publishes bridgeOptions derived from config via setBridgeConfig', () => {
    const config = createTestConfiguration({
      defaultPrivacyLevel: 'allow',
      allowedRendererHosts: ['example.com'],
      profilingSampleRate: 0,
      sessionReplaySampleRate: 0,
    });
    mockSetBridgeConfig.mockClear();
    new RendererPipeline(eventManager, hooks, config);
    expect(mockSetBridgeConfig).toHaveBeenCalledWith({
      defaultPrivacyLevel: 'allow',
      allowedRendererHosts: ['example.com'],
      capabilities: [],
    });
  });

  describe('capabilities', () => {
    it('advertises the profiles capability when profilingSampleRate > 0', () => {
      const config = createTestConfiguration({ profilingSampleRate: 100, sessionReplaySampleRate: 0 });
      mockSetBridgeConfig.mockClear();
      new RendererPipeline(new EventManager(), createFormatHooks(), config);
      expect((mockSetBridgeConfig.mock.calls[0]?.[0] as BridgeOptions).capabilities).toEqual(['profiles']);
    });

    it('advertises replay and profiling capabilities when both are enabled', () => {
      const config = createTestConfiguration({ profilingSampleRate: 100, sessionReplaySampleRate: 100 });
      mockSetBridgeConfig.mockClear();
      new RendererPipeline(new EventManager(), createFormatHooks(), config);
      expect((mockSetBridgeConfig.mock.calls[0]?.[0] as BridgeOptions).capabilities).toEqual(['profiles', 'records']);
    });

    it('advertises no capabilities when profiling and replay are disabled', () => {
      const config = createTestConfiguration({ profilingSampleRate: 0, sessionReplaySampleRate: 0 });
      mockSetBridgeConfig.mockClear();
      new RendererPipeline(new EventManager(), createFormatHooks(), config);
      expect((mockSetBridgeConfig.mock.calls[0]?.[0] as BridgeOptions).capabilities).toEqual([]);
    });
  });

  describe('rum events', () => {
    it('emits a ServerRumEvent with source RENDERER', () => {
      hooks.registerRum(() => ({ session: { id: 'main-session' }, application: { id: 'main-app' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(serverEvents).toHaveLength(1);
      expect(serverEvents[0].source).toBe(EventSource.RENDERER);
      expect(serverEvents[0].track).toBe(EventTrack.RUM);
    });

    it('overrides session.id and application.id from hook result', () => {
      hooks.registerRum(() => ({ session: { id: 'main-session' }, application: { id: 'main-app' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      const data = serverEvents[0].data;
      expect(data.session.id).toBe('main-session');
      expect(data.application.id).toBe('main-app');
    });

    it('injects container.view.id from hook result', () => {
      hooks.registerRum(() => ({ container: { view: { id: 'main-view-id' } } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      const data = serverEvents[0].data;
      expect(data.container).toMatchObject({ view: { id: 'main-view-id' } });
    });

    it('injects container.source from hook result', () => {
      hooks.registerRum(() => ({ application: { id: 'main-app' }, container: { source: 'electron' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(serverEvents[0].data.container).toMatchObject({ source: 'electron' });
    });

    it('applies beforeSendRum after enrichment with the renderer source', () => {
      hooks.registerRum(() => ({ session: { id: 'main-session' } }));
      let callbackSource: string | undefined;
      let callbackSessionId: string | undefined;
      const beforeSendRum: RumBeforeSend = (event, { source }) => {
        callbackSource = source;
        callbackSessionId = event.session.id;
        event.view.name = 'redacted view';
        return true;
      };
      new RendererPipeline(eventManager, hooks, createTestConfiguration({ beforeSendRum }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(callbackSource).toBe('renderer');
      expect(callbackSessionId).toBe('main-session');
      expect(serverEvents[0].data.view.name).toBe('redacted view');
    });

    it('does not emit renderer events discarded by beforeSendRum', () => {
      new RendererPipeline(
        eventManager,
        hooks,
        createTestConfiguration({ beforeSendRum: (event) => event.type !== 'action' })
      );

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_CLICK_DATA }));

      expect(serverEvents).toHaveLength(0);
    });

    it('preserves renderer source, service, view, and ddtags', () => {
      hooks.registerRum(() => ({ session: { id: 'main-session' }, application: { id: 'main-app' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      const data = serverEvents[0].data;
      expect(data.source).toBe('browser');
      expect(data.service).toBe('renderer-service');
      expect(data.view.id).toBe('renderer-view-id');
      expect(data.ddtags).toBe('sdk_version:1.0.0');
    });

    it('preserves the Browser SDK trace sample rate during Electron enrichment', () => {
      registerCommonContext(createTestConfiguration({ traceSampleRate: 20 }), hooks);

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(serverEvents[0].data._dd.configuration?.trace_sample_rate).toBe(80);
    });

    it('passes event.data.date as startTime to triggerRum', () => {
      let capturedStartTime: TimeStamp | undefined;
      hooks.registerRum(({ startTime }) => {
        capturedStartTime = startTime;
        return {};
      });

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(capturedStartTime).toBe(12345);
    });

    it('discards the event when triggerRum returns DISCARDED', () => {
      hooks.registerRum(() => DISCARDED);

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(serverEvents).toHaveLength(0);
    });
  });

  describe('usr and account context', () => {
    it('injects main-process usr when the renderer event has none', () => {
      hooks.registerRum(() => ({ usr: { id: 'main-user', email: 'main@example.com' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(serverEvents[0].data.usr).toEqual({ id: 'main-user', email: 'main@example.com' });
    });

    it('injects main-process account when the renderer event has none', () => {
      hooks.registerRum(() => ({ account: { id: 'main-account', name: 'Acme' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(serverEvents[0].data.account).toEqual({ id: 'main-account', name: 'Acme' });
    });

    it('preserves the renderer usr and does not inject main-process usr', () => {
      hooks.registerRum(() => ({ usr: { id: 'main-user', email: 'main@example.com' } }));
      const event = { ...RENDERER_RUM_DATA, usr: { id: 'renderer-user' } };

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event }));

      expect(serverEvents[0].data.usr).toEqual({ id: 'renderer-user' });
    });

    it('preserves the renderer account and does not inject main-process account', () => {
      hooks.registerRum(() => ({ account: { id: 'main-account', name: 'Acme' } }));
      const event = { ...RENDERER_RUM_DATA, account: { id: 'renderer-account' } };

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event }));

      expect(serverEvents[0].data.account).toEqual({ id: 'renderer-account' });
    });

    it('treats an empty renderer usr as absent and injects main-process usr', () => {
      hooks.registerRum(() => ({ usr: { id: 'main-user' } }));
      const event = { ...RENDERER_RUM_DATA, usr: {} };

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event }));

      expect(serverEvents[0].data.usr).toEqual({ id: 'main-user' });
    });

    it('merges main-process usr with an anonymous-only renderer usr', () => {
      hooks.registerRum(() => ({ usr: { id: 'main-user', name: 'Alice' } }));
      const event = { ...RENDERER_RUM_DATA, usr: { anonymous_id: 'anonymous-user' } };

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event }));

      expect(serverEvents[0].data.usr).toEqual({
        anonymous_id: 'anonymous-user',
        id: 'main-user',
        name: 'Alice',
      });
    });

    it('preserves an explicit renderer usr that also has an anonymous id', () => {
      hooks.registerRum(() => ({ usr: { id: 'main-user', email: 'main@example.com' } }));
      const event = {
        ...RENDERER_RUM_DATA,
        usr: { anonymous_id: 'anonymous-user', id: 'renderer-user' },
      };

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event }));

      expect(serverEvents[0].data.usr).toEqual({
        anonymous_id: 'anonymous-user',
        id: 'renderer-user',
      });
    });

    it('keeps the renderer usr untouched when the main process has none', () => {
      hooks.registerRum(() => ({ session: { id: 'main-session' } }));
      const event = { ...RENDERER_RUM_DATA, usr: { id: 'renderer-user' } };

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event }));

      expect(serverEvents[0].data.usr).toEqual({ id: 'renderer-user' });
    });
  });

  describe('user activity tracking', () => {
    it('emits END_USER_ACTIVITY for click actions', () => {
      const lifecycleEvents: unknown[] = [];
      eventManager.registerHandler({
        canHandle: (e): e is EndUserActivityEvent => e.kind === EventKind.LIFECYCLE,
        handle: (e) => lifecycleEvents.push(e),
      });
      hooks.registerRum(() => ({ session: { id: 'session' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_CLICK_DATA }));

      expect(lifecycleEvents).toContainEqual({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.END_USER_ACTIVITY,
      });
    });

    it('emits END_USER_ACTIVITY for click actions even when triggerRum returns DISCARDED', () => {
      const lifecycleEvents: unknown[] = [];
      eventManager.registerHandler({
        canHandle: (e): e is EndUserActivityEvent => e.kind === EventKind.LIFECYCLE,
        handle: (e) => lifecycleEvents.push(e),
      });
      hooks.registerRum(() => DISCARDED);

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_CLICK_DATA }));

      expect(lifecycleEvents).toContainEqual({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.END_USER_ACTIVITY,
      });
      expect(serverEvents).toHaveLength(0);
    });

    it('does not emit END_USER_ACTIVITY for non-click events', () => {
      const lifecycleEvents: unknown[] = [];
      eventManager.registerHandler({
        canHandle: (e): e is EndUserActivityEvent => e.kind === EventKind.LIFECYCLE,
        handle: (e) => lifecycleEvents.push(e),
      });
      hooks.registerRum(() => ({ session: { id: 'session' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(lifecycleEvents).not.toContainEqual({
        kind: EventKind.LIFECYCLE,
        lifecycle: LifecycleKind.END_USER_ACTIVITY,
      });
    });
  });

  describe('profile bridge events', () => {
    it('dispatches RawProfileEvent when bridge sends a profile message', () => {
      const profilePayload = {
        profile: { format: 'json' } as BrowserProfileEvent,
        trace: {} as BrowserProfilerTrace,
      };
      const received: RawProfileEvent[] = [];
      eventManager.registerHandler<RawProfileEvent>({
        canHandle: (e): e is RawProfileEvent => e.kind === EventKind.RAW && e.format === EventFormat.PROFILE,
        handle: (e) => received.push(e),
      });

      simulateIpcMessage(JSON.stringify({ eventType: 'profile', event: profilePayload }));

      expect(received).toHaveLength(1);
      expect(received[0].format).toBe(EventFormat.PROFILE);
      expect(received[0].data).toEqual(profilePayload.profile);
      expect(received[0].trace).toEqual(profilePayload.trace);
      expect(received[0].source).toBe(EventSource.RENDERER);
    });

    it('reports telemetry error and drops malformed profile payloads', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'profile', event: { trace: {} } }));

      expect(spy).not.toHaveBeenCalled();
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('malformed profile');
    });
  });

  describe('record bridge events', () => {
    it('dispatches RawReplayEvent when bridge sends a record message', () => {
      const record = { type: 2, timestamp: 123 };
      const received: RawReplayEvent[] = [];
      eventManager.registerHandler<RawReplayEvent>({
        canHandle: (e): e is RawReplayEvent => e.kind === EventKind.RAW && e.format === EventFormat.REPLAY,
        handle: (e) => received.push(e),
      });

      simulateIpcMessage(JSON.stringify({ eventType: 'record', event: record, view: { id: 'view-1' } }));

      expect(received).toHaveLength(1);
      expect(received[0].format).toBe(EventFormat.REPLAY);
      expect(received[0].data).toEqual(record);
      expect(received[0].view).toEqual({ id: 'view-1' });
      expect(received[0].source).toBe(EventSource.RENDERER);
    });

    it('reports telemetry error and drops records missing view', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'record', event: { type: 2, timestamp: 123 } }));

      expect(spy).not.toHaveBeenCalled();
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('missing view');
    });

    it('reports telemetry error and drops malformed record payloads', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'record', event: 'not-an-object', view: { id: 'view-1' } }));

      expect(spy).not.toHaveBeenCalled();
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('malformed replay record');
    });

    it.each([
      ['empty view id', { id: '' }],
      ['missing view id', {}],
      ['non-string view id', { id: 123 }],
    ])('reports telemetry error and drops records with an %s', (_label, view) => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'record', event: { type: 2, timestamp: 123 }, view }));

      expect(spy).not.toHaveBeenCalled();
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('missing view');
    });

    it.each([
      ['missing timestamp', { type: 2 }],
      ['non-numeric timestamp', { type: 2, timestamp: 'now' }],
      ['null timestamp', { type: 2, timestamp: null }],
      ['missing type', { timestamp: 123 }],
    ])('reports telemetry error and drops records with %s', (_label, event) => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'record', event, view: { id: 'view-1' } }));

      expect(spy).not.toHaveBeenCalled();
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('invalid timestamp or type');
    });
  });

  describe('internal telemetry events', () => {
    function simulateTelemetry(data: Record<string, unknown> = RENDERER_TELEMETRY_DATA) {
      simulateIpcMessage(JSON.stringify({ eventType: 'internal_telemetry', event: data }));
    }

    it('emits a ServerTelemetryEvent with source RENDERER on the RUM track', () => {
      simulateTelemetry();

      expect(telemetryEvents).toHaveLength(1);
      expect(telemetryEvents[0].source).toBe(EventSource.RENDERER);
      expect(telemetryEvents[0].track).toBe(EventTrack.RUM);
      expect(telemetryEvents[0].data.telemetry).toEqual(RENDERER_TELEMETRY_DATA.telemetry);
    });

    it('triggers the telemetry hooks with the renderer source and the event date', () => {
      const callback = vi.fn(() => ({}));
      hooks.registerTelemetry(callback);

      simulateTelemetry();

      expect(callback).toHaveBeenCalledWith({ startTime: RENDERER_TELEMETRY_DATA.date, source: EventSource.RENDERER });
    });

    it('lets the main process context override the application and session the renderer reported', () => {
      hooks.registerTelemetry(() => ({ application: { id: 'main-app' }, session: { id: 'main-session' } }));

      simulateTelemetry();

      expect(telemetryEvents[0].data.application?.id).toBe('main-app');
      expect(telemetryEvents[0].data.session?.id).toBe('main-session');
    });

    it("keeps the browser SDK's own attributes, so the event still reports on the SDK that raised it", () => {
      hooks.registerTelemetry(() => ({ application: { id: 'main-app' } }));

      simulateTelemetry();

      expect(telemetryEvents[0].data).toMatchObject({
        date: RENDERER_TELEMETRY_DATA.date,
        source: 'browser',
        service: 'browser-rum-sdk',
        version: '6.0.0',
        view: { id: 'renderer-view-id' },
        ddtags: 'sdk_version:6.0.0,service:renderer-service',
      });
    });

    it('drops the event when a hook discards it', () => {
      hooks.registerTelemetry(() => DISCARDED);

      simulateTelemetry();

      expect(telemetryEvents).toHaveLength(0);
    });

    it('emits without sampling, deduplicating, or applying another limit', () => {
      for (let i = 0; i < 120; i++) simulateTelemetry();

      expect(telemetryEvents).toHaveLength(120);
    });

    it("removes the browser SDK's stub session when the main process has no matching session", () => {
      simulateTelemetry();

      expect(telemetryEvents[0].data.session).toBeUndefined();
    });

    it("relays telemetry whatever the host app's own telemetrySampleRate is, including 0", () => {
      const optedOutManager = new EventManager();
      const relayed: ServerTelemetryEvent[] = [];
      optedOutManager.registerHandler<ServerTelemetryEvent>({
        canHandle: (event): event is ServerTelemetryEvent =>
          event.kind === EventKind.SERVER && event.track === EventTrack.RUM,
        handle: (event) => relayed.push(event),
      });
      new RendererPipeline(optedOutManager, createFormatHooks(), createTestConfiguration({ telemetrySampleRate: 0 }));

      simulateTelemetry();

      // The renderer's own rate already decided this event should be sent, and the main process's
      // rate governs only what the Electron SDK reports about itself. Pinned so the crossover is not
      // reintroduced as a "fix".
      expect(relayed).toHaveLength(1);
      expect(mockAddError).not.toHaveBeenCalled();
    });

    it('relays a kind the schema does not define, which the browser SDK can add before we sync', () => {
      simulateTelemetry({ ...RENDERER_TELEMETRY_DATA, telemetry: { type: 'a-kind-added-later' } });

      expect(telemetryEvents).toHaveLength(1);
      expect(telemetryEvents[0].data.telemetry).toEqual({ type: 'a-kind-added-later' });
      expect(mockAddError).not.toHaveBeenCalled();
    });

    it('relays log-shaped telemetry with no kind, which the schema makes optional for error/debug', () => {
      // `status` is the discriminator here: the schema requires it on the two variants that make
      // `type` optional, so a payload carrying one is well-formed telemetry, not an empty shell.
      // Pinned so requiring `type` outright is not reintroduced as a "fix" — it would silently drop
      // the renderer's error telemetry, the stream we would need to notice anything else breaking.
      const telemetry = { status: 'error', message: 'no type' };
      simulateTelemetry({ ...RENDERER_TELEMETRY_DATA, telemetry });

      expect(telemetryEvents).toHaveLength(1);
      expect(telemetryEvents[0].data.telemetry).toEqual(telemetry);
      expect(mockAddError).not.toHaveBeenCalled();
    });

    it.each([
      ['a payload that is not an object', 'a string'],
      ['a null payload', null],
      ['an event that is not telemetry', { type: 'view', date: 12345 }],
      ['an event with no date, which resolves the session and view', { type: 'telemetry' }],
      ['an event with a non-numeric date', { type: 'telemetry', date: '12345' }],
      ['an event with no telemetry payload, i.e. an empty shell', { type: 'telemetry', date: 12345 }],
      ['an event whose telemetry payload is empty', { type: 'telemetry', date: 12345, telemetry: {} }],
      ['an event whose telemetry payload is an array', { type: 'telemetry', date: 12345, telemetry: [] }],
    ])('reports a telemetry error and drops %s', (_label, event) => {
      simulateIpcMessage(JSON.stringify({ eventType: 'internal_telemetry', event }));

      expect(telemetryEvents).toHaveLength(0);
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('malformed telemetry');
    });
  });

  describe('unimplemented event types', () => {
    it('does not emit for log events (TODO)', () => {
      const spy = vi.spyOn(eventManager, 'notify');
      simulateIpcMessage(JSON.stringify({ eventType: 'log', event: { message: 'hello' } }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('invalid messages', () => {
    it('reports telemetry error on malformed JSON', () => {
      simulateIpcMessage('not valid json{{{');
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('Failed to parse');
    });

    it('reports telemetry error on unknown event type', () => {
      simulateIpcMessage(JSON.stringify({ eventType: 'unknown', event: {} }));
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('Unhandled bridge event type');
    });
  });

  describe('origin enforcement (integration)', () => {
    it('processes messages from an allowed origin', () => {
      const config = createTestConfiguration({ allowedRendererHosts: ['example.com'], profilingSampleRate: 0 });
      new RendererPipeline(eventManager, hooks, config);

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }), 'https://example.com');

      expect(serverEvents).toHaveLength(1);
    });

    it('drops messages from a disallowed origin', () => {
      const config = createTestConfiguration({ allowedRendererHosts: ['example.com'], profilingSampleRate: 0 });
      new RendererPipeline(eventManager, hooks, config);

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }), 'https://other.com');

      expect(serverEvents).toHaveLength(0);
    });
  });
});
