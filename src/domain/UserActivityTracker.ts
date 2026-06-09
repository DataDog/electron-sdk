import { EventKind, EventSource, EventTrack, LifecycleKind } from '../event';
import type { EventManager, ServerRumEvent } from '../event';

/**
 * Bridges user interactions into session management.
 *
 * Listens for renderer ServerRumEvents and emits `END_USER_ACTIVITY` whenever
 * a click action is received, keeping sessions alive based on real user interactions.
 *
 * @see SessionManager for how `END_USER_ACTIVITY` drives session renewal.
 */
export class UserActivityTracker {
  constructor(eventManager: EventManager) {
    eventManager.registerHandler<ServerRumEvent>({
      canHandle: (event): event is ServerRumEvent =>
        event.kind === EventKind.SERVER && event.track === EventTrack.RUM && event.source === EventSource.RENDERER,
      handle: (event, notify) => {
        const { data } = event;
        if (data.type === 'action' && data.action.type === 'click') {
          notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        }
      },
    });
  }
}
