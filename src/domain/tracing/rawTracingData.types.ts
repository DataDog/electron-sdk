import { ServerDuration, TimeStamp } from '@datadog/browser-core';

export interface RawTraceData {
  env: string;
  spans: RawSpanData[];
}

export interface RawSpanData {
  start: TimeStamp;
  duration: ServerDuration;
  trace_id: string;
  span_id: string;
  parent_id: string;
  name: string;
  service: string;
  resource: string;
  type: string;
  error: number;
  meta: Record<string, string>;
  metrics: Record<string, number>;
}
