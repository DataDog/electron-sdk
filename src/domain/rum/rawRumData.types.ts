import { RecursivePartial } from '@datadog/browser-core';
import { RumViewEvent } from './rumEvent.types';

export type RawRumData = RawRumView;

export interface RawRumView extends RecursivePartial<RumViewEvent> {
  type: 'view';
  view: {
    id: string;
    name: string;
    url: string;
    time_spent: number;
    action: { count: number };
    error: { count: number };
    resource: { count: number };
  };
  _dd: { document_version: number };
}
