import { EventManager } from '../event/EventManager';
import { RawEvent, ServerEvent, Event } from '../event/types';
import { EventKind, EventTrack } from '../event/constants';

export class Assembly {
  constructor(private eventManager: EventManager<Event>) {
    this.eventManager.registerHandler({
      canHandle: (event): event is RawEvent => event.kind === EventKind.RAW,
      handle: (event) => {
        const rawEvent = event as RawEvent;
        const serverEvent: ServerEvent = {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          data: rawEvent.data,
        };
        this.eventManager.notify(serverEvent);
      },
    });
  }
}
