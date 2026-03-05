import { RecursivePartial, ServerDuration } from '@datadog/browser-core';
import { RumErrorEvent, RumViewEvent } from './rumEvent.types';

export type RawRumData = RawRumView | RawRumError;

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
