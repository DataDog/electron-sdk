import { DISCARDED, generateUUID, type ServerDuration, type TimeStamp } from '@datadog/browser-core';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { type FormatHooks } from '../../assembly';
import { type Configuration } from '../../config';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack } from '../../event';
import { computeIntakeHostname } from '../../transport';
import { RawRumResource } from '../rum';
import { monitor } from '../telemetry';

interface ExportedSpan {
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
  start: number;
  duration: number;
  [key: string]: unknown;
}

const DD_TRACE_SPAN_CHANNEL = 'datadog:apm:electron:export';

function isHttpSpan(span: ExportedSpan): boolean {
  return span.type === 'http' && !!span.meta['http.url'];
}

function spanToPayload(span: ExportedSpan, service: string, extraMeta?: Record<string, string>) {
  return {
    ...span,
    service,
    trace_id: span.trace_id.toString(16),
    span_id: span.span_id.toString(16),
    parent_id: span.parent_id.toString(16),
    meta: { ...span.meta, ...extraMeta },
  };
}

function spanToResource(span: ExportedSpan): RawRumResource {
  return {
    type: 'resource',
    date: (span.start / 1e6) as TimeStamp, // ns → ms
    resource: {
      id: generateUUID(),
      duration: span.duration as ServerDuration, // already in ns
      type: 'native',
      method: (span.meta['http.method'] as RawRumResource['resource']['method']) || 'GET',
      status_code: Number(span.meta['http.status_code']) || 0,
      url: span.meta['http.url'],
    },
    _dd: {
      trace_id: span.trace_id.toString(10),
      span_id: span.span_id.toString(10),
      format_version: 2,
    },
  };
}

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
    const processedSpans: ReturnType<typeof spanToPayload>[] = [];

    for (const span of trace) {
      if (this.isIntakeRequest(span)) {
        continue;
      }

      const enrichedPayload = this.enrichSpan(span);
      processedSpans.push(enrichedPayload);

      if (isHttpSpan(span)) {
        this.emitResource(span);
      }
    }

    this.emitTraceEnvelope(processedSpans);
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

  private enrichSpan(span: ExportedSpan): ReturnType<typeof spanToPayload> {
    const startTime = (span.start / 1e6) as TimeStamp;
    const hookResult = this.hooks.triggerSpan({ startTime });
    const extraMeta = hookResult !== DISCARDED ? hookResult : undefined;
    return spanToPayload(span, this.service, extraMeta);
  }

  private emitResource(span: ExportedSpan): void {
    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: spanToResource(span),
      startTime: (span.start / 1e6) as TimeStamp,
    });
  }

  private emitTraceEnvelope(spans: ReturnType<typeof spanToPayload>[]): void {
    if (spans.length === 0) return;
    this.eventManager.notify({
      kind: EventKind.SERVER,
      track: EventTrack.SPANS,
      data: { env: this.env, spans },
    });
  }

  stop(): void {
    this.channel.unsubscribe(this.onMessage);
  }
}
