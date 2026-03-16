import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventFormat, EventKind, EventManager, EventSource } from '../event';
import type { RawRumEvent } from '../event';
import { BridgeHandler } from './BridgeHandler';
import type { BridgeOptions } from './BridgeHandler';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';

const { mockIpcMainOn, mockAddError } = vi.hoisted(() => {
  const mockIpcMainOn = vi.fn();
  const mockAddError = vi.fn();
  return { mockIpcMainOn, mockAddError };
});

vi.mock('electron', () => ({
  ipcMain: {
    on: mockIpcMainOn,
  },
}));

vi.mock('../domain/telemetry', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  monitor: (fn: Function) => fn,
  addError: mockAddError,
}));

const DEFAULT_BRIDGE_OPTIONS: BridgeOptions = {
  defaultPrivacyLevel: 'mask',
  allowedWebViewHosts: [],
};

describe('BridgeHandler', () => {
  let eventManager: EventManager;
  let simulateIpcMessage: (msg: string) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();

    mockIpcMainOn.mockImplementation((channel: string, callback: (_event: unknown, msg: string) => void) => {
      if (channel === BRIDGE_CHANNEL) {
        simulateIpcMessage = (msg: string) => callback({}, msg);
      }
    });

    new BridgeHandler(eventManager, DEFAULT_BRIDGE_OPTIONS);
  });

  it('should register an IPC listener on the bridge channel', () => {
    expect(mockIpcMainOn).toHaveBeenCalledWith(BRIDGE_CHANNEL, expect.any(Function));
  });

  it('should register an IPC listener on the config channel', () => {
    expect(mockIpcMainOn).toHaveBeenCalledWith(CONFIG_CHANNEL, expect.any(Function));
  });

  it('should return bridge options via event.returnValue on config channel', () => {
    const options: BridgeOptions = { defaultPrivacyLevel: 'allow', allowedWebViewHosts: ['example.com'] };
    vi.clearAllMocks();

    const handlers: Record<string, (event: unknown) => void> = {};
    mockIpcMainOn.mockImplementation((channel: string, callback: (event: unknown) => void) => {
      handlers[channel] = callback;
    });

    new BridgeHandler(eventManager, options);

    const event = { returnValue: undefined as unknown };
    handlers[CONFIG_CHANNEL](event);

    expect(event.returnValue).toEqual(options);
  });

  describe('rum events', () => {
    it('should notify the event manager with a RawRumEvent', () => {
      const collected: RawRumEvent[] = [];
      eventManager.registerHandler<RawRumEvent>({
        canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW,
        handle: (event) => collected.push(event),
      });

      const rumData = { type: 'view', view: { id: 'abc' } };
      simulateIpcMessage(JSON.stringify({ eventType: 'rum', event: rumData }));

      expect(collected).toHaveLength(1);
      expect(collected[0]).toEqual({
        kind: EventKind.RAW,
        source: EventSource.RENDERER,
        format: EventFormat.RUM,
        data: rumData,
      });
    });
  });

  describe('log events', () => {
    it('should not notify the event manager (not yet implemented)', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'log', event: { message: 'hello' } }));

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('internal_telemetry events', () => {
    it('should not notify the event manager (not yet implemented)', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'internal_telemetry', event: {} }));

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('invalid messages', () => {
    it('should not notify on malformed JSON', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage('not valid json{{{');

      expect(spy).not.toHaveBeenCalled();
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('Failed to parse');
    });

    it('should not notify on unknown event type', () => {
      const spy = vi.spyOn(eventManager, 'notify');

      simulateIpcMessage(JSON.stringify({ eventType: 'unknown', event: {} }));

      expect(spy).not.toHaveBeenCalled();
      expect(mockAddError).toHaveBeenCalledOnce();
      expect((mockAddError.mock.calls[0][0] as Error).message).toContain('Unhandled bridge event type');
    });
  });
});
