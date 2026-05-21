import { DISCARDED, generateUUID, type ServerDuration, type TimeStamp } from '@datadog/browser-core';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { type FormatHooks } from '../../assembly';
import { type Configuration } from '../../config';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack } from '../../event';
import { computeIntakeHostname } from '../../transport';
import { RawResourceMethod, RawRumResource } from '../rum';
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
      method: (span.meta['http.method'] as RawResourceMethod) || 'GET',
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

export class ResourceConverter {
  private channel: DiagnosticsChannel.Channel;
  private onMessage: (message: unknown) => void;
  private sdkHostname: string;
  private env: string;
  private service: string;

  constructor(
    private eventManager: EventManager,
    private hooks: FormatHooks,
    config: Configuration
  ) {
    this.env = config.env ?? '';
    this.service = config.service;
    this.sdkHostname = computeIntakeHostname(config.site, config.proxy);
    this.channel = DiagnosticsChannel.channel(DD_TRACE_SPAN_CHANNEL);

    this.onMessage = monitor((message: unknown) => {
      const traces = message as ExportedSpan[][];
      for (const trace of traces) {
        const processedSpans: ReturnType<typeof spanToPayload>[] = [];

        for (const span of trace) {
          const url = span.meta['http.url'];
          if (url && this.isSdkRequest(url)) {
            continue;
          }

          // Enrich span meta with electron context (application, session, view)
          const startTime = (span.start / 1e6) as TimeStamp;
          const hookResult = this.hooks.triggerSpan({ startTime });
          const extraMeta = hookResult !== DISCARDED ? hookResult : undefined;

          const payload = spanToPayload(span, this.service, extraMeta);
          processedSpans.push(payload);

          // Additionally convert HTTP spans to RUM resources
          if (isHttpSpan(span)) {
            this.eventManager.notify({
              kind: EventKind.RAW,
              source: EventSource.MAIN,
              format: EventFormat.RUM,
              data: spanToResource(span),
              startTime,
            });
          }
        }

        // Send the trace envelope to the span intake
        if (processedSpans.length > 0) {
          this.eventManager.notify({
            kind: EventKind.SERVER,
            track: EventTrack.SPANS,
            data: { env: this.env, spans: processedSpans },
          });
        }
      }
    });

    this.channel.subscribe(this.onMessage);
  }

  private isSdkRequest(url: string): boolean {
    try {
      return new URL(url).hostname === this.sdkHostname;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.channel.unsubscribe(this.onMessage);
  }
}
