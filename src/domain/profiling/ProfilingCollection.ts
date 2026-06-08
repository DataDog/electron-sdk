import { combine } from '@datadog/browser-core';
import type { Configuration } from '../../config';
import type { SessionManager } from '../session';
import { EventKind, EventFormat, EventTrack } from '../../event';
import type { EventManager, RawProfileEvent, ServerProfileEvent, BrowserProfileEvent } from '../../event';

export class ProfilingCollection {
  constructor(
    eventManager: EventManager,
    private readonly sessionManager: Pick<SessionManager, 'getSession'>,
    private readonly config: Configuration
  ) {
    eventManager.registerHandler<RawProfileEvent>({
      canHandle: (event): event is RawProfileEvent =>
        event.kind === EventKind.RAW && event.format === EventFormat.PROFILE,
      handle: (event, notify) => {
        const server = this.enrich(event);
        if (server) notify(server);
      },
    });
  }

  private enrich(event: RawProfileEvent): ServerProfileEvent | null {
    const session = this.sessionManager.getSession();
    if (session.status !== 'active') return null;

    return {
      kind: EventKind.SERVER,
      track: EventTrack.PROFILE,
      data: combine(event.data, {
        session: { id: session.id },
        application: { id: this.config.applicationId },
      }) as BrowserProfileEvent,
      trace: event.trace,
    };
  }
}
