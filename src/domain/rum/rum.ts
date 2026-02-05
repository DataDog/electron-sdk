import type { Configuration } from '../../config';
import type { RumViewEvent } from './rumEvent.types';
import { EventKind, EventSource } from '../../event/constants';
import { generateUUID } from '@datadog/browser-core';
import { EventManager } from '../../event/EventManager';

export class DummyMainView {
  constructor(
    private config: Configuration,
    private sessionId: string,
    private eventManager: EventManager
  ) {
    const viewEvent = createDummyViewEvent(this.config, this.sessionId);
    this.eventManager.notify({ kind: EventKind.RAW, source: EventSource.MAIN, data: viewEvent });
  }
}

function createDummyViewEvent(config: Configuration, sessionId: string): RumViewEvent {
  const viewId = generateUUID();
  const timestamp = Date.now();

  return {
    type: 'view',
    date: timestamp,
    source: 'electron',
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
