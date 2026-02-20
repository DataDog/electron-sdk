import { elapsed, generateUUID, TimeStamp, timeStampNow, toServerDuration } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../event';
import type { FormatHooks } from '../../assembly';
import type { RawRumView } from './rawRumData.types';

interface ViewState {
  id: string;
  name: string;
  url: string;
  startTime: TimeStamp;
  documentVersion: number;
  isActive: boolean;
  counters: { action: { count: number }; error: { count: number }; resource: { count: number } };
}

/**
 * Track the main view lifecycle
 * - on creation, emit an initial view event
 */
export class ViewCollection {
  private currentView!: ViewState;

  constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks
  ) {
    this.createNewView();
    this.registerHooks();
  }

  stop(): void {
    /* implemented in subsequent step */
  }

  private createNewView(): void {
    this.currentView = {
      id: generateUUID(),
      name: 'main process', // TODO(RUM-14657) improve name / url
      url: 'electron://main-process',
      startTime: timeStampNow(),
      documentVersion: 1,
      isActive: true,
      counters: { action: { count: 0 }, error: { count: 0 }, resource: { count: 0 } },
    };

    this.emitViewUpdate();
  }

  private emitViewUpdate(): void {
    const viewEvent: RawRumView = {
      type: 'view',
      view: {
        id: this.currentView.id,
        name: this.currentView.name,
        url: this.currentView.url,
        time_spent: toServerDuration(elapsed(this.currentView.startTime, timeStampNow())),
        is_active: this.currentView.isActive,
        ...this.currentView.counters,
      },
      _dd: { document_version: this.currentView.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: viewEvent,
    });
  }

  private registerHooks(): void {
    this.hooks.registerRum(() => ({
      view: { id: this.currentView.id, name: this.currentView.name, url: this.currentView.url },
    }));

    this.hooks.registerTelemetry(() => ({
      view: { id: this.currentView.id },
    }));
  }
}
