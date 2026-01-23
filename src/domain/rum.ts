import type { Configuration } from '../config';
import type { RumViewEvent } from '../rumEvent.types';

/**
 * UUID v4
 * from https://gist.github.com/jed/982883
 */
export function generateUUID(placeholder?: string): string {
  return placeholder
    ? (parseInt(placeholder, 10) ^ ((Math.random() * 16) >> (parseInt(placeholder, 10) / 4))).toString(16)
    : `${1e7}-${1e3}-${4e3}-${8e3}-${1e11}`.replace(/[018]/g, generateUUID);
}

export function createDummyViewEvent(config: Configuration): RumViewEvent {
  const sessionId = generateUUID();
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
