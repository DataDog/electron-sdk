import { EventManager } from '../event/EventManager';
import type { RawEvent, ServerEvent } from '../event/types';
import { EventKind, EventTrack } from '../event/constants';

export class Assembly {
  constructor(private eventManager: EventManager) {
    this.eventManager.registerHandler<RawEvent>({
      canHandle: (event) => event.kind === EventKind.RAW,
      handle: (event, notify) => {
        const serverEvent: ServerEvent = {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          data: event.data,
        };
        notify(serverEvent);
      },
    });
  }
}
