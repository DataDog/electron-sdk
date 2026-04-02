import { EventFormat, EventKind, EventSource, LifecycleKind } from '../event';
import type { EventManager, RawRumEvent } from '../event';
import type { RumEvent } from './rum';

/**
 * Bridges user interactions into session management.
 *
 * Listens for raw renderer RUM events and emits `END_USER_ACTIVITY` whenever
 * a click action is received from the browser-rum SDK, keeping sessions alive
 * automatically based on real user interactions.
 *
 * ```
 * renderer click → browser-rum → BridgeHandler (RawRumEvent)
 *   → UserActivityTracker → END_USER_ACTIVITY → SessionManager.updateActivity()
 * ```
 *
 * In the future, we should probably add support for other browser interactions somehow and maybe some electron or customer events as well.
 *
 * @see SessionManager for how `END_USER_ACTIVITY` drives session renewal.
 */
export class UserActivityTracker {
  constructor(eventManager: EventManager) {
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent =>
        event.kind === EventKind.RAW && event.source === EventSource.RENDERER && event.format === EventFormat.RUM,
      handle: (event, notify) => {
        const data = event.data as unknown as RumEvent;
        if (data.type === 'action' && data.action.type === 'click') {
          notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
        }
      },
    });
  }
}
