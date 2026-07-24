import { EventManager } from '../../event';
import type { FormatHooks } from '../../assembly';
import { ErrorCollection, CrashCollection } from './error';
import { VitalCollection } from './vital';
import { OperationCollection } from './operation';
import { ViewCollection } from './view';
import { SessionManager } from '../session';

export class RumCollection {
  private constructor(
    private readonly viewCollection: ViewCollection,
    private readonly errorCollection: ErrorCollection,
    private readonly vitalCollection: VitalCollection,
    private readonly operationCollection: OperationCollection
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    sessionManager: SessionManager
  ): Promise<RumCollection> {
    const viewCollection = await ViewCollection.start(eventManager, hooks, sessionManager);
    const errorCollection = new ErrorCollection(eventManager);
    const vitalCollection = new VitalCollection(eventManager);
    const operationCollection = new OperationCollection(eventManager);
    CrashCollection.start(eventManager);
    return new RumCollection(viewCollection, errorCollection, vitalCollection, operationCollection);
  }

  getApi() {
    return {
      ...this.errorCollection.getApi(),
      ...this.vitalCollection.getApi(),
      ...this.operationCollection.getApi(),
    };
  }

  stop(): void {
    this.viewCollection.stop();
    this.errorCollection.stop();
    this.vitalCollection.stop();
    this.operationCollection.stop();
  }
}
