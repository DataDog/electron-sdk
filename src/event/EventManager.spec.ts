import { describe, it, expect, vi } from 'vitest';
import { EventManager } from './EventManager';
import type { EventHandler, RawEvent, RawRumEvent, ServerEvent } from './event.types';
import { EventFormat, EventKind, EventSource, EventTrack } from './event.constants';
import { createRawRumView } from '../mocks.specUtil';
import { RecursivePartial } from '@datadog/browser-core';
import { RawRumView, RumEvent } from '../domain/rum';

function createRawRumEvent(overrides?: RecursivePartial<RawRumEvent>): RawRumEvent {
  return {
    kind: EventKind.RAW,
    source: EventSource.RENDERER,
    format: EventFormat.RUM,
    ...overrides,
    data: createRawRumView(overrides?.data as RecursivePartial<RawRumView>),
    startTime: undefined,
  };
}

function createServerEvent(overrides: Partial<ServerEvent> = {}): ServerEvent {
  return {
    kind: EventKind.SERVER,
    track: EventTrack.RUM,
    data: {} as RumEvent,
    ...overrides,
  } as ServerEvent;
}

describe('EventManager', () => {
  it('calls handler.handle when canHandle returns true', () => {
    const eventManager = new EventManager();
    const mockHandler = {
      canHandle: vi.fn().mockReturnValue(true),
      handle: vi.fn(),
    } as unknown as EventHandler<RawEvent>;

    eventManager.registerHandler<RawEvent>(mockHandler);
    const event = createRawRumEvent();
    eventManager.notify(event);

    expect(mockHandler.canHandle).toHaveBeenCalledWith(event);
    expect(mockHandler.handle).toHaveBeenCalledWith(event, expect.any(Function));
  });

  it('skips handler when canHandle returns false', () => {
    const eventManager = new EventManager();
    const handle = vi.fn();

    eventManager.registerHandler<RawEvent>({
      canHandle: (_event): _event is RawEvent => false,
      handle,
    });
    eventManager.notify(createRawRumEvent());

    expect(handle).not.toHaveBeenCalled();
  });

  it('processes array of events', () => {
    const eventManager = new EventManager();
    const handled: RawEvent[] = [];

    eventManager.registerHandler<RawEvent>({
      canHandle: (event) => event.kind === EventKind.RAW,
      handle: (event) => handled.push(event),
    });
    eventManager.notify([
      createRawRumEvent({ data: { view: { id: '1' } } }),
      createRawRumEvent({ data: { view: { id: '2' } } }),
    ]);

    expect(handled).toHaveLength(2);
  });

  it('allows handler to emit new events via notify callback', () => {
    const eventManager = new EventManager();
    const collected: ServerEvent[] = [];

    eventManager.registerHandler<RawEvent>({
      canHandle: (event) => event.kind === EventKind.RAW,
      handle: (_event, notify) => notify(createServerEvent()),
    });
    eventManager.registerHandler<ServerEvent>({
      canHandle: (event) => event.kind === EventKind.SERVER,
      handle: (event) => collected.push(event),
    });

    eventManager.notify(createRawRumEvent());

    expect(collected).toHaveLength(1);
    expect(collected[0].kind).toBe(EventKind.SERVER);
  });

  it('provides correctly typed events to handlers without casting', () => {
    const eventManager = new EventManager();
    let receivedSource: (typeof EventSource)[keyof typeof EventSource] | undefined;
    let receivedTrack: (typeof EventTrack)[keyof typeof EventTrack] | undefined;

    eventManager.registerHandler<RawEvent>({
      canHandle: (event) => event.kind === EventKind.RAW,
      handle: (event) => {
        // event is RawEvent - no cast needed, source is accessible
        receivedSource = event.source;
      },
    });

    eventManager.registerHandler<ServerEvent>({
      canHandle: (event) => event.kind === EventKind.SERVER,
      handle: (event) => {
        // event is ServerEvent - no cast needed, track is accessible
        receivedTrack = event.track;
      },
    });

    eventManager.notify(createRawRumEvent({ source: EventSource.MAIN }));
    eventManager.notify(createServerEvent({ track: EventTrack.LOGS }));

    expect(receivedSource).toBe(EventSource.MAIN);
    expect(receivedTrack).toBe(EventTrack.LOGS);
  });

  it('should unregister a handler (through subscription)', () => {
    const eventManager = new EventManager();
    const mockHandler = {
      canHandle: vi.fn().mockReturnValue(true),
      handle: vi.fn(),
    } as unknown as EventHandler<RawEvent>;

    const subscription = eventManager.registerHandler(mockHandler);
    subscription.unsubscribe();
    const event = createRawRumEvent();
    eventManager.notify(event);

    expect(mockHandler.canHandle).not.toHaveBeenCalled();
    expect(mockHandler.handle).not.toHaveBeenCalled();
  });

  it('should unregister a handler (through API)', () => {
    const eventManager = new EventManager();
    const mockHandler = {
      canHandle: vi.fn().mockReturnValue(true),
      handle: vi.fn(),
    } as unknown as EventHandler<RawEvent>;

    eventManager.registerHandler(mockHandler);
    eventManager.removeHandler(mockHandler);
    const event = createRawRumEvent();
    eventManager.notify(event);

    expect(mockHandler.canHandle).not.toHaveBeenCalled();
    expect(mockHandler.handle).not.toHaveBeenCalled();
  });
});
