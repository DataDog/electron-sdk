import { EventManager } from '../../event';
import type { FormatHooks } from '../../assembly';
import { ActionCollection } from './action';
import { ErrorCollection, CrashCollection } from './error';
import { OperationCollection } from './operation';
import { ViewCollection } from './view';

export class RumCollection {
  private constructor(
    private readonly viewCollection: ViewCollection,
    private readonly errorCollection: ErrorCollection,
    private readonly operationCollection: OperationCollection,
    private readonly actionCollection: ActionCollection
  ) {}

  static async start(eventManager: EventManager, hooks: FormatHooks): Promise<RumCollection> {
    const viewCollection = await ViewCollection.start(eventManager, hooks);
    const errorCollection = new ErrorCollection(eventManager);
    const operationCollection = new OperationCollection(eventManager);
    const actionCollection = new ActionCollection(eventManager);
    CrashCollection.start(eventManager);
    return new RumCollection(viewCollection, errorCollection, operationCollection, actionCollection);
  }

  getApi() {
    return {
      ...this.errorCollection.getApi(),
      ...this.operationCollection.getApi(),
      ...this.actionCollection.getApi(),
    };
  }

  stop(): void {
    this.viewCollection.stop();
    this.errorCollection.stop();
    this.operationCollection.stop();
    this.actionCollection.stop();
  }
}
