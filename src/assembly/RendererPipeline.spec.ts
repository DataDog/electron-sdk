import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type TimeStamp } from '@datadog/js-core/time';
import { DISCARDED } from '@datadog/js-core/assembly';
import { RendererPipeline, type BridgeOptions } from './RendererPipeline';
import { createFormatHooks, type FormatHooks } from './hooks';
import {
  EventKind,
  EventManager,
  EventSource,
  EventTrack,
  LifecycleKind,
  type EndUserActivityEvent,
  type ServerRumEvent,
} from '../event';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';

const { mockIpcMainOn, mockAddError } = vi.hoisted(() => {
  const mockIpcMainOn = vi.fn();
  const mockAddError = vi.fn();
  return { mockIpcMainOn, mockAddError };
});

vi.mock('electron', () => ({
  ipcMain: { on: mockIpcMainOn },
}));

vi.mock('../domain/telemetry', () => ({
  monitor: (fn: () => void) => fn,
  addError: mockAddError,
}));

const DEFAULT_OPTIONS: BridgeOptions = {
  defaultPrivacyLevel: 'mask',
  allowedWebViewHosts: [],
};

const RENDERER_RUM_DATA = {
  type: 'view',
  date: 12345 as TimeStamp,
  source: 'browser',
  service: 'renderer-service',
  application: { id: 'renderer-app-id' },
  session: { id: 'renderer-session-id', type: 'user' },
  view: { id: 'renderer-view-id', name: 'My View', url: 'http://localhost' },
  ddtags: 'sdk_version:1.0.0',
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

describe('RendererPipeline', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let simulateIpcMessage: (msg: string) => void;
  let serverEvents: ServerRumEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    hooks = createFormatHooks();
    serverEvents = [];

    mockIpcMainOn.mockImplementation((channel: string, callback: (_event: unknown, msg: string) => void) => {
      if (channel === BRIDGE_CHANNEL) {
        simulateIpcMessage = (msg: string) => callback({}, msg);
      }
    });

    eventManager.registerHandler<ServerRumEvent>({
      canHandle: (event): event is ServerRumEvent => event.kind === EventKind.SERVER && event.track === EventTrack.RUM,
      handle: (event) => serverEvents.push(event),
    });

    new RendererPipeline(eventManager, hooks, DEFAULT_OPTIONS);
  });

  it('registers IPC listeners on BRIDGE_CHANNEL and CONFIG_CHANNEL', () => {
    expect(mockIpcMainOn).toHaveBeenCalledWith(BRIDGE_CHANNEL, expect.any(Function));
    expect(mockIpcMainOn).toHaveBeenCalledWith(CONFIG_CHANNEL, expect.any(Function));
  });

  it('returns bridgeOptions on CONFIG_CHANNEL', () => {
    const options: BridgeOptions = { defaultPrivacyLevel: 'allow', allowedWebViewHosts: ['example.com'] };
    vi.clearAllMocks();
    const handlers: Record<string, (event: unknown) => void> = {};
    mockIpcMainOn.mockImplementation((channel: string, cb: (event: unknown) => void) => {
      handlers[channel] = cb;
    });
    new RendererPipeline(eventManager, hooks, options);
    const event = { returnValue: undefined as unknown };
    handlers[CONFIG_CHANNEL](event);
    expect(event.returnValue).toEqual(options);
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

    it('preserves renderer source, service, view, and ddtags', () => {
      hooks.registerRum(() => ({ session: { id: 'main-session' }, application: { id: 'main-app' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      const data = serverEvents[0].data;
      expect(data.source).toBe('browser');
      expect(data.service).toBe('renderer-service');
      expect(data.view.id).toBe('renderer-view-id');
      expect(data.ddtags).toBe('sdk_version:1.0.0');
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

  describe('unimplemented event types', () => {
    it('does not emit for log events (TODO)', () => {
      const spy = vi.spyOn(eventManager, 'notify');
      simulateIpcMessage(JSON.stringify({ eventType: 'log', event: { message: 'hello' } }));
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not emit for internal_telemetry events (TODO)', () => {
      const spy = vi.spyOn(eventManager, 'notify');
      simulateIpcMessage(JSON.stringify({ eventType: 'internal_telemetry', event: {} }));
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
});
