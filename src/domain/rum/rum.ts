import { EventManager } from '../../event';
import type { FormatHooks } from '../../assembly';
import { ViewCollection } from './view';

export class RumCollection {
  private viewCollection: ViewCollection;

  constructor(eventManager: EventManager, hooks: FormatHooks) {
    this.viewCollection = new ViewCollection(eventManager, hooks);
  }

  stop(): void {
    this.viewCollection.stop();
  }
}
