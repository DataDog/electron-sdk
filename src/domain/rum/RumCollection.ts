import { EventManager } from '../../event';
import type { FormatHooks } from '../../assembly';
import { ChildProcessCollection } from './childProcess';
import { ErrorCollection, CrashCollection } from './error';
import { ViewCollection } from './view';

export class RumCollection {
  private constructor(
    private readonly viewCollection: ViewCollection,
    private readonly errorCollection: ErrorCollection,
    private readonly childProcessCollection: ChildProcessCollection
  ) {}

  static async start(eventManager: EventManager, hooks: FormatHooks): Promise<RumCollection> {
    const viewCollection = await ViewCollection.start(eventManager, hooks);
    const errorCollection = new ErrorCollection(eventManager);
    const childProcessCollection = new ChildProcessCollection(eventManager);
    CrashCollection.start(eventManager);
    return new RumCollection(viewCollection, errorCollection, childProcessCollection);
  }

  getApi() {
    return {
      ...this.errorCollection.getApi(),
    };
  }

  stop(): void {
    this.viewCollection.stop();
    this.errorCollection.stop();
    this.childProcessCollection.stop();
  }
}
