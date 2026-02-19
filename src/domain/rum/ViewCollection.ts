import {
  elapsed,
  generateUUID,
  ONE_MINUTE,
  Subscription,
  TimeStamp,
  timeStampNow,
  toServerDuration,
} from '@datadog/browser-core';
import {
  EventFormat,
  EventKind,
  EventManager,
  EventSource,
  EventTrack,
  type LifecycleEvent,
  LifecycleKind,
  ServerRumEvent,
} from '../../event';
import type { FormatHooks } from '../../assembly';
import { setInterval } from '../telemetry';
import type { RawRumView } from './rawRumData.types';

export const SESSION_KEEP_ALIVE_INTERVAL = 5 * ONE_MINUTE;

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
 * - keep session alive by regularly send view updates
 * - on SESSION_EXPIRED, emit a final inactive view update
 * - on SESSION_RENEW, create a new view
 * - on RUM server event (action, error, resource), increment view counters
 */
export class ViewCollection {
  private currentView!: ViewState;
  private keepAliveIntervalId: ReturnType<typeof setInterval> | undefined;
  private lifecycleSubscription: Subscription;
  private serverEventSubscription: Subscription;

  constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks
  ) {
    this.createNewView();
    this.registerHooks();

    this.lifecycleSubscription = this.eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => {
        if (event.lifecycle === LifecycleKind.SESSION_EXPIRED) {
          this.onSessionExpired();
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          this.onSessionRenew();
        }
      },
    });

    this.serverEventSubscription = this.eventManager.registerHandler<ServerRumEvent>({
      canHandle: (event): event is ServerRumEvent => event.kind === EventKind.SERVER && event.track === EventTrack.RUM,
      handle: (event) => this.onServerRumEvent(event),
    });
  }

  stop(): void {
    this.stopSessionKeepAlive();
    this.lifecycleSubscription.unsubscribe();
    this.serverEventSubscription.unsubscribe();
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
    this.keepSessionAlive();
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

  private onSessionExpired(): void {
    this.stopSessionKeepAlive();
    this.currentView.isActive = false;
    this.currentView.documentVersion++;
    this.emitViewUpdate();
  }

  private onSessionRenew(): void {
    this.createNewView();
  }

  private onServerRumEvent(event: ServerRumEvent): void {
    const type = event.data.type;
    if (type === 'action' || type === 'error' || type === 'resource') {
      this.currentView.counters[type].count++;
      this.currentView.documentVersion++;
      this.emitViewUpdate();
    }
  }

  private keepSessionAlive(): void {
    this.stopSessionKeepAlive();
    this.keepAliveIntervalId = setInterval(() => {
      this.currentView.documentVersion++;
      this.emitViewUpdate();
      this.keepSessionAlive();
    }, SESSION_KEEP_ALIVE_INTERVAL);
  }

  private stopSessionKeepAlive(): void {
    if (this.keepAliveIntervalId !== undefined) {
      clearInterval(this.keepAliveIntervalId);
      this.keepAliveIntervalId = undefined;
    }
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
