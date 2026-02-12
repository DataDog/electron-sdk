import { EventFormat, EventKind, EventSource, EventTrack, LifecycleKind } from './event.constants';

export interface RawEvent {
  kind: typeof EventKind.RAW;
  source: (typeof EventSource)[keyof typeof EventSource];
  format: (typeof EventFormat)[keyof typeof EventFormat];
  data: unknown;
}

export interface ServerEvent {
  kind: typeof EventKind.SERVER;
  track: (typeof EventTrack)[keyof typeof EventTrack];
  data: unknown;
}

export interface EndUserActivityEvent {
  kind: typeof EventKind.LIFECYCLE;
  lifecycle: typeof LifecycleKind.END_USER_ACTIVITY;
}

export interface SessionRenewEvent {
  kind: typeof EventKind.LIFECYCLE;
  lifecycle: typeof LifecycleKind.SESSION_RENEW;
}

export type LifecycleEvent = EndUserActivityEvent | SessionRenewEvent;
export type Event = RawEvent | ServerEvent | LifecycleEvent;

export interface EventHandler<T extends Event> {
  canHandle: (event: Event) => event is T;
  handle: (event: T, notify: (event: Event | Event[]) => void) => void;
}
