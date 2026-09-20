import { EventFormat, EventKind, EventSource, EventTrack, LifecycleKind } from './event.constants';
import { RawTelemetryData, TelemetryEvent } from '../domain/telemetry';
import { MainRumEvent, RawRumData, RendererRumEvent } from '../domain/rum';
import type { TimeStamp } from '@datadog/js-core/time';
import { RawTraceData } from '../domain/tracing/rawTracingData.types';
import type { BrowserProfileEvent, BrowserProfilerTrace } from '../domain/profiling';
import type { ReplaySegmentPayload, BrowserRecord } from '../domain/replay';
import type { LogsEvent } from '../domain/logs';
import type { TrackingConsent } from '../config';

export type { BrowserProfileEvent, BrowserProfilerTrace };

export type RawEvent = RawRumEvent | RawTelemetryEvent | RawProfileEvent | RawReplayEvent;

export interface RawRumEvent {
  kind: typeof EventKind.RAW;
  format: typeof EventFormat.RUM;
  data: RawRumData;
  startTime?: TimeStamp;
  /** Completion timestamp for events that describe an interval. */
  consentTime?: number;
  /** Capture-time decision for events exported after their capture interval. */
  storageConsent?: TrackingConsent;
}

export interface RawTelemetryEvent {
  kind: typeof EventKind.RAW;
  format: typeof EventFormat.TELEMETRY;
  data: RawTelemetryData;
  startTime?: TimeStamp;
}

export interface RawReplayEvent {
  kind: typeof EventKind.RAW;
  source: typeof EventSource.RENDERER;
  format: typeof EventFormat.REPLAY;
  data: BrowserRecord;
  view: { id: string };
  startTime?: TimeStamp;
}

export type ServerEvent =
  ServerRumEvent | ServerTelemetryEvent | ServerLogsEvent | ServerSpansEvent | ServerProfileEvent | ServerReplayEvent;

/**
 * Server events transported as newline-delimited JSON, i.e. every {@link ServerEvent} whose
 * `data` is the full payload to serialize. Excludes {@link ServerProfileEvent}, which carries
 * an additional `trace` field and is transported as a multipart profile.
 */
export type StandardServerEvent = Exclude<ServerEvent, ServerProfileEvent | ServerReplayEvent>;

interface ConsentRouting {
  /** Completion timestamp for an event that covers an interval. Never serialized. */
  consentTime?: TimeStamp;
  /** Precomputed decision for a payload containing multiple intervals. Never serialized. */
  storageConsent?: TrackingConsent;
}

export interface ServerRendererRumEvent extends ConsentRouting {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.RUM;
  source: typeof EventSource.RENDERER;
  data: RendererRumEvent;
}

export interface ServerMainRumEvent extends ConsentRouting {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.RUM;
  source: typeof EventSource.MAIN;
  data: MainRumEvent;
}

export type ServerRumEvent = ServerRendererRumEvent | ServerMainRumEvent;

export interface ServerTelemetryEvent extends ConsentRouting {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.RUM;
  source: EventSource;
  data: TelemetryEvent;
}

export interface ServerLogsEvent extends ConsentRouting {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.LOGS;
  source: EventSource;
  data: LogsEvent;
}

export interface ServerSpansEvent extends ConsentRouting {
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

export interface ServerProfileEvent extends ConsentRouting {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.PROFILE;
  data: BrowserProfileEvent;
  trace: BrowserProfilerTrace;
}

export interface ServerReplayEvent extends ConsentRouting {
  kind: typeof EventKind.SERVER;
  track: typeof EventTrack.REPLAY;
  data: ReplaySegmentPayload;
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
