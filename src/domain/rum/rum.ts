import { generateUUID } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../event';
import { RawRumView } from './rawRumData.types';

export class DummyMainView {
  constructor(private eventManager: EventManager) {
    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: createDummyViewEvent(),
    });
  }
}

function createDummyViewEvent(): RawRumView {
  return {
    type: 'view',
    view: {
      id: generateUUID(),
      name: 'dummy-view',
      url: 'electron://app',
      time_spent: 0,
      action: { count: 0 },
      error: { count: 0 },
      resource: { count: 0 },
    },
    _dd: { document_version: 1 },
  };
}
