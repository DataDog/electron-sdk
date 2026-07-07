import { timeStampNow } from '@datadog/js-core/time';
import { type Context, generateUUID } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager } from '../../../event';
import type { RawRumAction } from '../rawRumData.types';

/**
 * Collect manually-tracked RUM custom actions (`addAction`) emitted from the main process.
 */
export class ActionCollection {
  constructor(private readonly eventManager: EventManager) {}

  getApi() {
    return {
      addAction: (name: string, context?: Context) => this.emitAction(name, context),
    };
  }

  stop(): void {
    // No owned resources to release; method kept for RumCollection symmetry.
  }

  private emitAction(name: string, context?: Context): void {
    const startTime = timeStampNow();
    const data: RawRumAction = {
      type: 'action',
      date: startTime,
      context: context ?? {},
      action: {
        id: generateUUID(),
        type: 'custom',
        target: { name },
      },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data,
      startTime,
    });
  }
}
