import { combine, DISCARDED, generateUUID, type ServerDuration, type TimeStamp } from '@datadog/browser-core';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { type FormatHooks } from '../../assembly';
import { type Configuration } from '../../config';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack } from '../../event';
import { computeIntakeHostname } from '../../transport';
import { RawRumResource } from '../rum';
import { monitor } from '../telemetry';
import { NsTimeStamp, RawSpanData, RawTraceData } from './rawTracingData.types';

/**
 * Structure of spans exported by dd-trace electron exporter.
 */
export interface ExportedSpan {
  trace_id: { toString: (radix?: number) => string };
  span_id: { toString: (radix?: number) => string };
  parent_id: { toString: (radix?: number) => string };
  name: string;
  service: string;
  resource: string;
  type: string;
  error: number;
  meta: Record<string, string>;
  metrics: Record<string, number>;
  start: NsTimeStamp;
  duration: ServerDuration;
  [key: string]: unknown;
}

const DD_TRACE_SPAN_CHANNEL = 'datadog:apm:electron:export';

/**
 * Subscribes to dd-trace's diagnostics channel and processes exported spans:
 * 1. Filters out SDK-internal requests (intake / proxy)
 * 2. Enriches spans with electron context (application, session, view)
 * 3. Emits RUM resource events for HTTP spans
 * 4. Emits span envelopes to the span intake
 */
export class SpanProcessor {
  private channel: DiagnosticsChannel.Channel;
  private onMessage: (message: unknown) => void;
  private intakeHostname: string;
  private env: string;
  private service: string;

  constructor(
    private eventManager: EventManager,
    private hooks: FormatHooks,
    config: Configuration
  ) {
    this.env = config.env ?? '';
    this.service = config.service;
    this.intakeHostname = computeIntakeHostname(config.site, config.proxy);
    this.channel = DiagnosticsChannel.channel(DD_TRACE_SPAN_CHANNEL);

    this.onMessage = monitor((message: unknown) => {
      const traces = message as ExportedSpan[][];
      for (const trace of traces) {
        this.processTrace(trace);
      }
    });

    this.channel.subscribe(this.onMessage);
  }

  private processTrace(trace: ExportedSpan[]): void {
    const processedSpans: RawSpanData[] = [];

    for (const exportedSpan of trace) {
      if (this.isIntakeRequest(exportedSpan)) {
        continue;
      }
      const span = toRawSpan(exportedSpan, this.service);
      const hookResult = this.hooks.triggerSpan({ startTime: toTimeStamp(span.start) });
      if (hookResult === DISCARDED) {
        continue;
      }

      processedSpans.push(combine(span, hookResult));

      if (isHttpSpan(exportedSpan)) {
        this.emitResource(spanToResource(exportedSpan));
      }
    }

    const processedTrace = { env: this.env, spans: processedSpans };
    this.emitServerSpansEvent(processedTrace);
  }

  private isIntakeRequest(span: ExportedSpan): boolean {
    if (span.resource?.includes(this.intakeHostname)) {
      return true;
    }
    const url = span.meta['http.url'];
    if (!url) return false;
    try {
      return new URL(url).hostname === this.intakeHostname;
    } catch {
      return false;
    }
  }

  private emitResource(resource: RawRumResource): void {
    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: resource,
      startTime: resource.date,
    });
  }

  private emitServerSpansEvent(trace: RawTraceData): void {
    if (trace.spans.length === 0) return;
    this.eventManager.notify({
      kind: EventKind.SERVER,
      track: EventTrack.SPANS,
      data: trace,
    });
  }

  stop(): void {
    this.channel.unsubscribe(this.onMessage);
  }
}

function isHttpSpan(span: ExportedSpan): boolean {
  return span.type === 'http' && !!span.meta['http.url'];
}

function toRawSpan(exportedSpan: ExportedSpan, service: string): RawSpanData {
  return {
    ...exportedSpan,
    service,
    start: exportedSpan.start,
    duration: exportedSpan.duration,
    trace_id: exportedSpan.trace_id.toString(16),
    span_id: exportedSpan.span_id.toString(16),
    parent_id: exportedSpan.parent_id.toString(16),
  };
}

function spanToResource(exportedSpan: ExportedSpan): RawRumResource {
  return {
    type: 'resource',
    date: toTimeStamp(exportedSpan.start),
    resource: {
      id: generateUUID(),
      duration: exportedSpan.duration,
      type: 'native',
      method: (exportedSpan.meta['http.method'] as RawRumResource['resource']['method']) || 'GET',
      status_code: Number(exportedSpan.meta['http.status_code']) || 0,
      url: exportedSpan.meta['http.url'],
    },
    _dd: {
      trace_id: exportedSpan.trace_id.toString(10),
      span_id: exportedSpan.span_id.toString(10),
      format_version: 2,
    },
  };
}

function toTimeStamp(nsTimeStamp: NsTimeStamp): TimeStamp {
  return (nsTimeStamp / 1e6) as TimeStamp;
}
