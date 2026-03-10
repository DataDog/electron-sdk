import { EventManager } from '../../event';
import type { FormatHooks } from '../../assembly';
import { ErrorCollection } from './ErrorCollection';
import { ViewCollection } from './ViewCollection';

export class RumCollection {
  private viewCollection: ViewCollection;
  private errorCollection: ErrorCollection;

  constructor(eventManager: EventManager, hooks: FormatHooks) {
    this.viewCollection = new ViewCollection(eventManager, hooks);
    this.errorCollection = new ErrorCollection(eventManager);
  }

  getApi() {
    return {
      ...this.errorCollection.getApi(),
    };
  }

  stop(): void {
    this.viewCollection.stop();
    this.errorCollection.stop();
  }
}
