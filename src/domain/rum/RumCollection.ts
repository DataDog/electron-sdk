import { EventManager } from '../../event';
import type { FormatHooks } from '../../assembly';
import { ErrorCollection, CrashCollection } from './error';
import { ViewCollection } from './view';

export class RumCollection {
  private constructor(
    private readonly viewCollection: ViewCollection,
    private readonly errorCollection: ErrorCollection
  ) {}

  static async start(eventManager: EventManager, hooks: FormatHooks): Promise<RumCollection> {
    const viewCollection = await ViewCollection.start(eventManager, hooks);
    const errorCollection = new ErrorCollection(eventManager);
    CrashCollection.start(eventManager);
    return new RumCollection(viewCollection, errorCollection);
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
