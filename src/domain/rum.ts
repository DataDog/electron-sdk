import type { Configuration } from '../config';
import type { RumViewEvent } from '../rumEvent.types';
import { generateUUID } from '@datadog/browser-core';

export function createDummyViewEvent(config: Configuration, sessionId: string): RumViewEvent {
  const viewId = generateUUID();
  const timestamp = Date.now();

  return {
    type: 'view',
    date: timestamp,
    source: 'browser', // TODO: use electron RUM-13964
    service: config.service,
    session: {
      id: sessionId,
      type: 'user',
    },
    view: {
      id: viewId,
      name: 'dummy-view',
      url: 'electron://app',
      time_spent: 0,
      action: { count: 0 },
      error: { count: 0 },
      resource: { count: 0 },
    },
    application: {
      id: config.applicationId,
    },
    _dd: {
      format_version: 2,
      document_version: 1,
    },
  };
}
