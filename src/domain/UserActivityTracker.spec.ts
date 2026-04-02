import { describe, it, expect, beforeEach } from 'vitest';
import { EventManager, EventKind, EventSource, EventFormat, LifecycleKind, type LifecycleEvent } from '../event';
import { UserActivityTracker } from './UserActivityTracker';
import type { RumActionEvent } from './rum';

describe('UserActivityTracker', () => {
  let eventManager: EventManager;
  let lifecycleEvents: string[];

  beforeEach(() => {
    eventManager = new EventManager();
    lifecycleEvents = [];
    eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => lifecycleEvents.push(event.lifecycle),
    });
    new UserActivityTracker(eventManager);
  });

  function notifyRendererRumEvent(data: unknown) {
    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.RENDERER,
      format: EventFormat.RUM,
      data,
    } as never);
  }

  function makeClickAction(): Partial<RumActionEvent> {
    return { type: 'action', action: { type: 'click' } };
  }

  it('emits END_USER_ACTIVITY when a renderer click action is received', () => {
    notifyRendererRumEvent(makeClickAction());

    expect(lifecycleEvents).toContain(LifecycleKind.END_USER_ACTIVITY);
  });

  it('does not emit END_USER_ACTIVITY for a non-click renderer action', () => {
    notifyRendererRumEvent({ type: 'action', action: { type: 'custom' } });

    expect(lifecycleEvents).not.toContain(LifecycleKind.END_USER_ACTIVITY);
  });

  it('does not emit END_USER_ACTIVITY for a non-action renderer event', () => {
    notifyRendererRumEvent({ type: 'view' });

    expect(lifecycleEvents).not.toContain(LifecycleKind.END_USER_ACTIVITY);
  });

  it('does not emit END_USER_ACTIVITY for a main process RAW event', () => {
    eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: makeClickAction(),
    } as never);

    expect(lifecycleEvents).not.toContain(LifecycleKind.END_USER_ACTIVITY);
  });
});
