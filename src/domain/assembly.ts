import { EventManager, EventKind, EventTrack, type RawEvent, type ServerEvent } from '../event';

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
