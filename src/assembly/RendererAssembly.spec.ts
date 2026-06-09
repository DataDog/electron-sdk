import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCARDED, type TimeStamp } from '@datadog/browser-core';
import { RendererAssembly, type BridgeOptions } from './RendererAssembly';
import { createFormatHooks, type FormatHooks } from './hooks';
import { EventKind, EventManager, EventSource, EventTrack, type ServerRumEvent } from '../event';
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

describe('RendererAssembly', () => {
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

    new RendererAssembly(eventManager, hooks, DEFAULT_OPTIONS);
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
    new RendererAssembly(eventManager, hooks, options);
    const event = { returnValue: undefined as unknown };
    handlers[CONFIG_CHANNEL](event);
    expect(event.returnValue).toEqual(options);
  });

  describe('rum events', () => {
    it('emits a ServerRumEvent with source RENDERER', () => {
      hooks.registerRenderer(() => ({ session: { id: 'main-session' }, application: { id: 'main-app' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(serverEvents).toHaveLength(1);
      expect(serverEvents[0].source).toBe(EventSource.RENDERER);
      expect(serverEvents[0].track).toBe(EventTrack.RUM);
    });

    it('overrides session.id and application.id from hook result', () => {
      hooks.registerRenderer(() => ({ session: { id: 'main-session' }, application: { id: 'main-app' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      const data = serverEvents[0].data;
      expect(data.session.id).toBe('main-session');
      expect(data.application.id).toBe('main-app');
    });

    it('injects container.view.id and container.source from hook result', () => {
      hooks.registerRenderer(() => ({ view: { id: 'main-view-id' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      const data = serverEvents[0].data;
      expect(data.container).toEqual({ view: { id: 'main-view-id' }, source: 'electron' });
    });

    it('preserves renderer source, service, view, and ddtags', () => {
      hooks.registerRenderer(() => ({ session: { id: 'main-session' }, application: { id: 'main-app' } }));

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      const data = serverEvents[0].data;
      expect(data.source).toBe('browser');
      expect(data.service).toBe('renderer-service');
      expect(data.view.id).toBe('renderer-view-id');
      expect(data.ddtags).toBe('sdk_version:1.0.0');
    });

    it('passes event.data.date as startTime to triggerRenderer', () => {
      let capturedStartTime: TimeStamp | undefined;
      hooks.registerRenderer((params) => {
        capturedStartTime = params.startTime;
        return {};
      });

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(capturedStartTime).toBe(12345);
    });

    it('discards the event when triggerRenderer returns DISCARDED', () => {
      hooks.registerRenderer(() => DISCARDED);

      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: RENDERER_RUM_DATA }));

      expect(serverEvents).toHaveLength(0);
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
