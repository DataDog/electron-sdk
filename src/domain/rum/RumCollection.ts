import { EventManager } from '../../event';
import type { FormatHooks } from '../../assembly';
import { ErrorCollection, CrashCollection } from './error';
import { DurationVitalCollection } from './duration';
import { OperationCollection } from './operation';
import { ViewCollection } from './view';

export class RumCollection {
  private constructor(
    private readonly viewCollection: ViewCollection,
    private readonly errorCollection: ErrorCollection,
    private readonly durationVitalCollection: DurationVitalCollection,
    private readonly operationCollection: OperationCollection
  ) {}

  static async start(eventManager: EventManager, hooks: FormatHooks): Promise<RumCollection> {
    const viewCollection = await ViewCollection.start(eventManager, hooks);
    const errorCollection = new ErrorCollection(eventManager);
    const durationVitalCollection = new DurationVitalCollection(eventManager);
    const operationCollection = new OperationCollection(eventManager);
    CrashCollection.start(eventManager);
    return new RumCollection(viewCollection, errorCollection, durationVitalCollection, operationCollection);
  }

  getApi() {
    return {
      ...this.errorCollection.getApi(),
      ...this.durationVitalCollection.getApi(),
      ...this.operationCollection.getApi(),
    };
  }

  stop(): void {
    this.viewCollection.stop();
    this.errorCollection.stop();
    this.durationVitalCollection.stop();
    this.operationCollection.stop();
  }
}
