import type { EventKind, EventSource, EventTrack } from './constants';

export interface RawEvent {
  kind: typeof EventKind.RAW;
  source: (typeof EventSource)[keyof typeof EventSource];
  data: unknown;
}

export interface ServerEvent {
  kind: typeof EventKind.SERVER;
  track: (typeof EventTrack)[keyof typeof EventTrack];
  data: unknown;
}

export interface LifecyleEvent {
  kind: typeof EventKind.LIFECYCLE;
  data: unknown;
}

export type Event = RawEvent | ServerEvent | LifecyleEvent;

export interface EventHandler<T extends Event> {
  canHandle: (event: Event) => event is T;
  handle: (event: T, notify: (event: Event | Event[]) => void) => void;
}
