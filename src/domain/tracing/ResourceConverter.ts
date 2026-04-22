import { DISCARDED, generateUUID, type TimeStamp } from '@datadog/browser-core';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { type FormatHooks } from '../../assembly';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack } from '../../event';
import { RawResourceMethod, RawRumResource } from '../rum';
import { addError } from '../telemetry';
import { displayInfo } from '../../tools/display';

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

function isSdkRequest(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname.startsWith('browser-intake-');
  } catch {
    return false;
  }
}

function isHttpSpan(span: ExportedSpan): boolean {
  return span.type === 'http' && !!span.meta['http.url'];
}

function spanToPayload(span: ExportedSpan, extraMeta?: Record<string, string>) {
  return {
    ...span,
    trace_id: span.trace_id.toString(16),
    span_id: span.span_id.toString(16),
    parent_id: span.parent_id.toString(16),
    meta: { ...span.meta, ...extraMeta },
  };
}

function spanToResource(span: ExportedSpan): RawRumResource {
  return {
    type: 'resource',
    date: span.start / 1e6, // ns → ms
    resource: {
      id: generateUUID(),
      duration: span.duration, // already in ns
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

  constructor(
    private eventManager: EventManager,
    private hooks: FormatHooks,
    private env: string
  ) {
    this.channel = DiagnosticsChannel.channel(DD_TRACE_SPAN_CHANNEL);

    this.onMessage = (message: unknown) => {
      try {
        const traces = message as ExportedSpan[][];

        for (const trace of traces) {
          const processedSpans: ReturnType<typeof spanToPayload>[] = [];

          for (const span of trace) {
            const url = span.meta['http.url'];
            if (url && isSdkRequest(url)) {
              continue;
            }

            // Enrich span meta with electron context (application, session, view)
            const startTime = (span.start / 1e6) as TimeStamp;
            const hookResult = this.hooks.triggerSpan({ startTime });
            const extraMeta = hookResult !== DISCARDED ? hookResult : undefined;

            const payload = spanToPayload(span, extraMeta);
            displayInfo(
              'Span received:',
              span.name,
              `type=${span.type}`,
              `trace_id=${payload.trace_id}`,
              `span_id=${payload.span_id}`
            );
            processedSpans.push(payload);

            // Additionally convert HTTP spans to RUM resources
            if (isHttpSpan(span)) {
              displayInfo(
                '  → Converting to RUM resource:',
                span.meta['http.method'],
                url,
                `(${span.meta['http.status_code']})`
              );
              this.eventManager.notify({
                kind: EventKind.RAW,
                source: EventSource.MAIN,
                format: EventFormat.RUM,
                data: spanToResource(span),
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
      } catch (error) {
        addError(error);
      }
    };

    this.channel.subscribe(this.onMessage);
  }

  stop(): void {
    this.channel.unsubscribe(this.onMessage);
  }
}
