import { EventFormat, EventKind, EventSource, EventTrack, LifecycleKind } from './event.constants';
import { RawTelemetryData, TelemetryEvent } from '../domain/telemetry';
import { RawRumData, RumEvent } from '../domain/rum';
import type { TimeStamp } from '@datadog/js-core/time';
import { RawTraceData } from '../domain/tracing/rawTracingData.types';
import type { BrowserProfileEvent, BrowserProfilerTrace } from '../domain/profiling';

export type { BrowserProfileEvent, BrowserProfilerTrace };

export type RawEvent = RawRumEvent | RawTelemetryEvent | RawProfileEvent;

export interface RawRumEvent {
  kind: typeof EventKind.RAW;
  format: typeof EventFormat.RUM;
  data: RawRumData;
  startTime?: TimeStamp;
}

export interface RawTelemetryEvent {
  kind: typeof EventKind.RAW;
  format: typeof EventFormat.TELEMETRY;
  data: RawTelemetryData;
  startTime?: TimeStamp;
}

export type ServerEvent =
  | ServerRumEvent
  | ServerTelemetryEvent
  | ServerLogsEvent
  | ServerSpansEvent
  | ServerProfileEvent;

/**
 * Server events transported as newline-delimited JSON, i.e. every {@link ServerEvent} whose
 * `data` is the full payload to serialize. Excludes {@link ServerProfileEvent}, which carries
 * an additional `trace` field and is transported as a multipart profile.
 */
export type StandardServerEvent = Exclude<ServerEvent, ServerProfileEvent>;

export interface ServerRumEvent {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.RUM;
  source: EventSource;
  data: RumEvent;
}

export interface ServerTelemetryEvent {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.RUM;
  source: EventSource;
  data: TelemetryEvent;
}

export interface ServerLogsEvent {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.LOGS;
  source: EventSource;
  data: unknown;
}

export interface ServerSpansEvent {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.SPANS;
  source: EventSource;
  data: RawTraceData;
}

export interface RawProfileEvent {
  kind: typeof EventKind.RAW;
  source: typeof EventSource.RENDERER;
  format: typeof EventFormat.PROFILE;
  data: BrowserProfileEvent;
  trace: BrowserProfilerTrace;
}

export interface ServerProfileEvent {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.PROFILE;
  data: BrowserProfileEvent;
  trace: BrowserProfilerTrace;
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
