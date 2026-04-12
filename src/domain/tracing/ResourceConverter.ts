import { generateUUID } from '@datadog/browser-core';
import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { EventFormat, EventKind, EventManager, EventSource } from '../../event';
import { RawResourceMethod, RawRumResource } from '../rum';
import { addError } from '../telemetry';
import { displayInfo } from '../../tools/display';

interface ExportedSpan {
  trace_id: { toString: (radix?: number) => string };
  span_id: { toString: (radix?: number) => string };
  name: string;
  resource: string;
  type: string;
  meta: Record<string, string>;
  metrics: Record<string, number>;
  start: number;
  duration: number;
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

  constructor(private eventManager: EventManager) {
    this.channel = DiagnosticsChannel.channel(DD_TRACE_SPAN_CHANNEL);

    this.onMessage = (message: unknown) => {
      try {
        const traces = message as ExportedSpan[][];

        for (const trace of traces) {
          for (const span of trace) {
            if (!isHttpSpan(span)) {
              continue;
            }

            const url = span.meta['http.url'];
            if (isSdkRequest(url)) {
              continue;
            }

            const resource = spanToResource(span);
            displayInfo('HTTP trace received:', span.meta['http.method'], url, `(${span.meta['http.status_code']})`);
            this.eventManager.notify({
              kind: EventKind.RAW,
              source: EventSource.MAIN,
              format: EventFormat.RUM,
              data: resource,
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
