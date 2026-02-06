import { describe, it, expect, vi } from 'vitest';
import { EventManager } from './EventManager';
import type { Event, EventHandler, RawEvent, ServerEvent } from './types';
import { EventKind, EventSource, EventTrack } from './constants';

function createRawEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    kind: EventKind.RAW,
    source: EventSource.RENDERER,
    data: {},
    ...overrides,
  };
}

function createServerEvent(overrides: Partial<ServerEvent> = {}): ServerEvent {
  return {
    kind: EventKind.SERVER,
    track: EventTrack.RUM,
    data: {},
    ...overrides,
  };
}

describe('EventManager', () => {
  it('calls handler.handle when canHandle returns true', () => {
    const eventManager = new EventManager<Event>();
    const handler: EventHandler<Event> = {
      canHandle: vi.fn().mockReturnValue(true),
      handle: vi.fn(),
    };

    eventManager.registerHandler(handler);
    const event = createRawEvent();
    eventManager.notify(event);

    expect(handler.canHandle).toHaveBeenCalledWith(event);
    expect(handler.handle).toHaveBeenCalledWith(event, expect.any(Function));
  });

  it('skips handler when canHandle returns false', () => {
    const eventManager = new EventManager<Event>();
    const handler: EventHandler<Event> = {
      canHandle: vi.fn().mockReturnValue(false),
      handle: vi.fn(),
    };

    eventManager.registerHandler(handler);
    eventManager.notify(createRawEvent());

    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('processes array of events', () => {
    const eventManager = new EventManager<Event>();
    const handled: Event[] = [];
    const handler: EventHandler<Event> = {
      canHandle: () => true,
      handle: (event) => handled.push(event),
    };

    eventManager.registerHandler(handler);
    eventManager.notify([createRawEvent({ data: { id: 1 } }), createRawEvent({ data: { id: 2 } })]);

    expect(handled).toHaveLength(2);
  });

  it('allows handler to emit new events via notify callback', () => {
    const eventManager = new EventManager<Event>();
    const collected: Event[] = [];

    const emitter: EventHandler<Event> = {
      canHandle: (e) => e.kind === EventKind.RAW,
      handle: (_event, notify) => notify?.(createServerEvent()),
    };
    const collector: EventHandler<Event> = {
      canHandle: (e) => e.kind === EventKind.SERVER,
      handle: (event) => collected.push(event),
    };

    eventManager.registerHandler(emitter);
    eventManager.registerHandler(collector);
    eventManager.notify(createRawEvent());

    expect(collected).toHaveLength(1);
    expect(collected[0].kind).toBe(EventKind.SERVER);
  });
});
