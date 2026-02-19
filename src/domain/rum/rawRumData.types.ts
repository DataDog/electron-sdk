import { RecursivePartial, ServerDuration } from '@datadog/browser-core';
import { RumErrorEvent, RumViewEvent } from './rumEvent.types';

export type RawRumData = RawRumView | RawRumError;

export interface RawRumView extends RecursivePartial<RumViewEvent> {
  type: 'view';
  view: {
    id: string;
    name: string;
    url: string;
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
  error: {
    id: string;
    message: string;
    source: 'source';
    handling: 'unhandled';
    stack?: string;
    type?: string;
  };
}
