import { EventFormat, EventKind, EventSource, EventTrack, LifecycleKind } from './event.constants';
import { RawTelemetryData } from '../domain/telemetry';
import { RawRumData } from '../domain/rum';

export type RawEvent = RawRumEvent | RawTelemetryEvent;

export interface RawRumEvent {
  kind: typeof EventKind.RAW;
  source: (typeof EventSource)[keyof typeof EventSource];
  format: typeof EventFormat.RUM;
  data: RawRumData;
}

export interface RawTelemetryEvent {
  kind: typeof EventKind.RAW;
  source: (typeof EventSource)[keyof typeof EventSource];
  format: typeof EventFormat.TELEMETRY;
  data: RawTelemetryData;
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

export interface SessionExpiredEvent {
  kind: typeof EventKind.LIFECYCLE;
  lifecycle: typeof LifecycleKind.SESSION_EXPIRED;
}

export interface SessionRenewEvent {
  kind: typeof EventKind.LIFECYCLE;
  lifecycle: typeof LifecycleKind.SESSION_RENEW;
}

export type LifecycleEvent = EndUserActivityEvent | SessionExpiredEvent | SessionRenewEvent;
export type Event = RawEvent | ServerEvent | LifecycleEvent;

export interface EventHandler<T extends Event> {
  canHandle: (event: Event) => event is T;
  handle: (event: T, notify: (event: Event | Event[]) => void) => void;
}
