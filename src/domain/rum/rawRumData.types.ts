import { type TimeStamp, type ServerDuration } from '@datadog/js-core/time';
import { type RecursivePartial } from '@datadog/js-core/util';
import {
  RumErrorEvent,
  RumResourceEvent,
  RumViewEvent,
  RumVitalDurationEvent,
  RumVitalOperationStepEvent,
} from './rumEvent.types';

export type RawRumData = RawRumView | RawRumError | RawRumOperationStepVital | RawRumDurationVital | RawRumResource;

export interface RawRumView extends RecursivePartial<RumViewEvent> {
  type: 'view';
  view: {
    id: string;
    time_spent: ServerDuration;
    is_active: boolean;
    action: { count: number };
    error: { count: number };
    resource: { count: number };
  };
  _dd: { document_version: number };
}

export interface RawRumError extends RecursivePartial<RumErrorEvent> {
  type: 'error';
  context?: Record<string, unknown>;
  error: {
    id: string;
    message: string;
    source: 'source' | 'custom';
    handling: 'unhandled' | 'handled';
    stack?: string;
    type?: string;
    is_crash?: true;
    was_truncated?: boolean;
    category?: 'Exception';
    source_type?: RumErrorEvent['error']['source_type'];
    meta?: {
      code_type?: string;
      process?: string;
      exception_type?: string;
      path?: string;
    };
    threads?: {
      name: string;
      crashed: boolean;
      stack: string;
    }[];
    binary_images?: {
      uuid: string;
      name: string;
      is_system: boolean;
      load_address?: string;
      max_address?: string;
      arch?: string;
    }[];
  };
}

type RumVitalOperationStepEventVital = NonNullable<RumVitalOperationStepEvent['vital']>;

export interface RawRumOperationStepVital extends RecursivePartial<RumVitalOperationStepEvent> {
  type: 'vital';
  date: TimeStamp;
  context?: Record<string, unknown>;
  vital: {
    id: string;
    name?: string;
    description?: string;
    type: RumVitalOperationStepEventVital['type'];
    step_type: RumVitalOperationStepEventVital['step_type'];
    operation_key?: string;
    failure_reason?: RumVitalOperationStepEventVital['failure_reason'];
  };
}

type RumVitalDurationEventVital = NonNullable<RumVitalDurationEvent['vital']>;

export interface RawRumDurationVital extends RecursivePartial<RumVitalDurationEvent> {
  type: 'vital';
  date: TimeStamp;
  context?: Record<string, unknown>;
  vital: {
    id: string;
    name: string;
    description?: string;
    type: RumVitalDurationEventVital['type'];
    duration: ServerDuration;
  };
}

export interface RawRumResource extends RecursivePartial<RumResourceEvent> {
  type: 'resource';
  date: TimeStamp;
  resource: {
    id: string;
    duration: ServerDuration;
    type: 'native';
    method?: RumResourceEvent['resource']['method'];
    status_code: number;
    url: string;
  };
  _dd: {
    trace_id: string;
    span_id: string;
    format_version: 2;
  };
}
