import { type ServerDuration } from '@datadog/js-core/time';

export interface RawTraceData {
  env: string;
  spans: RawSpanData[];
}

export type NsTimeStamp = number & { t: 'Epoch time in nanoseconds' };

export interface RawSpanData {
  start: NsTimeStamp;
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
