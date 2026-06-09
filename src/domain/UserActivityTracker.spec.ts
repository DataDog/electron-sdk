import { beforeEach, describe, expect, it } from 'vitest';
import { EventKind, EventManager, EventSource, EventTrack, LifecycleKind } from '../event';
import type { LifecycleEvent, ServerRumEvent } from '../event';
import { UserActivityTracker } from './UserActivityTracker';
import type { RumEvent } from './rum';

function makeServerRumEvent(data: Partial<RumEvent>): ServerRumEvent {
  return {
    kind: EventKind.SERVER,
    track: EventTrack.RUM,
    source: EventSource.RENDERER,
    data: data as RumEvent,
  };
}

describe('UserActivityTracker', () => {
  let eventManager: EventManager;
  let lifecycleEvents: LifecycleEvent[];

  beforeEach(() => {
    eventManager = new EventManager();
    lifecycleEvents = [];

    eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => lifecycleEvents.push(event),
    });

    new UserActivityTracker(eventManager);
  });

  it('emits END_USER_ACTIVITY for a renderer click action', () => {
    eventManager.notify(makeServerRumEvent({ type: 'action', action: { type: 'click' } }));

    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0]).toEqual({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
  });

  it('does not emit for non-click actions', () => {
    eventManager.notify(makeServerRumEvent({ type: 'action', action: { type: 'tap' } }));

    expect(lifecycleEvents).toHaveLength(0);
  });

  it('does not emit for non-action events', () => {
    eventManager.notify(makeServerRumEvent({ type: 'error' }));

    expect(lifecycleEvents).toHaveLength(0);
  });

  it('does not emit for MAIN source events', () => {
    eventManager.notify({
      kind: EventKind.SERVER,
      track: EventTrack.RUM,
      source: EventSource.MAIN,
      data: { type: 'action', action: { type: 'click' } } as RumEvent,
    });

    expect(lifecycleEvents).toHaveLength(0);
  });
});
