import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
import type { RendererRumEvent } from '../domain/rum';
import type { SessionManager } from '../domain/session';

// Bounds the memory and work a renderer flooding the bridge with view ids can cause: real apps only move as many views
// as pages left open across a session change.
const MAX_MOVED_VIEWS = 100;

/**
 * Resolves the time at which a renderer RUM event is looked up by the format hooks (session, consent, execution
 * context, container view).
 *
 * A view event's date stays the view start, so a page left open across a session change would keep its view in the
 * session it started in, leaving the new session with only the fake view, which the backend does not create sessions
 * from. Each view therefore has an owner session, the one at its reference time: the time it last moved, or its date.
 * A view event is resolved:
 * - at its reference time while it stays in its owner session: same session, no tracked session, or an ended view with
 *   an owner, so a view that ended at a session change, or a final update sent between sessions, is not moved or lost;
 * - now otherwise, recorded as its new reference time: it moves to the current session, with that session's context.
 *
 * Accepted inconsistencies:
 * - only the latest owner session keeps the view, as the backend keeps a view's latest version;
 * - the moved view keeps its counters, time spent and date covering the whole page life, including a refused consent
 *   period;
 * - the moved view's replay link and stats may be wrong in its new session, as the renderer takes no full snapshot on a
 *   session change and the stats include segments sent under the previous session.
 *
 * TODO(RUM-18784): remove once the bridge notifies the browser SDK of session renewals, so it starts a new view in the
 * new session on its own.
 */
export class RendererViewStartTime {
  // Only moved views are tracked, kept until evicted past the cap (oldest move first) rather than after some silence, so
  // a suspended renderer keeps its owner session however long it pauses.
  private readonly moveTimes = new Map<string, TimeStamp>();

  constructor(private readonly sessionManager: Pick<SessionManager, 'getTrackedSessionId'>) {}

  resolve(event: RendererRumEvent): TimeStamp {
    const date = event.date as TimeStamp;
    if (event.type !== 'view') {
      return date;
    }
    const now = timeStampNow();
    const referenceTime = this.moveTimes.get(event.view.id) ?? date;

    const currentSessionId = this.sessionManager.getTrackedSessionId(now);
    const ownerSessionId = this.sessionManager.getTrackedSessionId(referenceTime);
    if (
      currentSessionId === undefined ||
      ownerSessionId === currentSessionId ||
      (event.view.is_active === false && ownerSessionId !== undefined)
    ) {
      return referenceTime;
    }

    // Re-inserted so that a view moved again counts as the newest move for the cap.
    this.moveTimes.delete(event.view.id);
    this.moveTimes.set(event.view.id, now);
    if (this.moveTimes.size > MAX_MOVED_VIEWS) {
      this.moveTimes.delete(this.moveTimes.keys().next().value!);
    }
    return now;
  }
}
