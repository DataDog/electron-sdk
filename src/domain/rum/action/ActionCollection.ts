import { timeStampNow } from '@datadog/js-core/time';
import { type Context, generateUUID } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager } from '../../../event';
import type { RawRumAction } from '../rawRumData.types';

/**
 * Collect manually-tracked RUM custom actions emitted from the main process.
 *
 * Parity note: the browser-sdk, iOS and Android all accept the action name verbatim — no emptiness or character-set
 * check (unlike operation/vital names, which are facet paths). None of them attach `frustration`, `loading_time` or
 * error/resource counts to a *custom* action: those are click/scope concepts. The main process has no DOM either, so
 * this only exposes `addAction` producing a `custom` action; auto-tracked click actions arrive from the renderer over
 * the bridge already assembled.
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
