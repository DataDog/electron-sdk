import {
  elapsed,
  generateUUID,
  ONE_MINUTE,
  ONE_SECOND,
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
} from '../../../event';
import type { FormatHooks } from '../../../assembly';
import { setInterval, throttle } from '../../telemetry';
import type { RawRumView } from '../rawRumData.types';
import { ViewContext } from './ViewContext';

export const SESSION_KEEP_ALIVE_INTERVAL = 5 * ONE_MINUTE;
// throttle view updates to avoid bursts
export const VIEW_UPDATE_THROTTLE_DELAY = 3 * ONE_SECOND;

interface ViewState {
  id: string;
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
 * - on RUM server event (action, error, resource), increment view counters (throttled)
 */
export class ViewCollection {
  private currentView!: ViewState;
  private viewContext: ViewContext;
  private keepAliveIntervalId: ReturnType<typeof setInterval> | undefined;
  private scheduleViewUpdate: () => void;
  private cancelScheduledViewUpdate: () => void;
  private lifecycleSubscription: Subscription;
  private serverEventSubscription: Subscription;

  constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks
  ) {
    const { throttled, cancel } = throttle(() => this.emitViewUpdate(), VIEW_UPDATE_THROTTLE_DELAY);
    this.scheduleViewUpdate = throttled;
    this.cancelScheduledViewUpdate = cancel;

    this.viewContext = new ViewContext(this.hooks);
    this.createNewView();

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
    this.cancelScheduledViewUpdate();
    this.stopSessionKeepAlive();
    this.lifecycleSubscription.unsubscribe();
    this.serverEventSubscription.unsubscribe();
  }

  private createNewView(): void {
    const viewId = generateUUID();
    this.currentView = {
      id: viewId,
      startTime: timeStampNow(),
      documentVersion: 1,
      isActive: true,
      counters: { action: { count: 0 }, error: { count: 0 }, resource: { count: 0 } },
    };

    this.viewContext.add(viewId);
    this.emitViewUpdate();
    this.keepSessionAlive();
  }

  private emitViewUpdate(): void {
    const viewEvent: RawRumView = {
      type: 'view',
      view: {
        id: this.currentView.id,
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
    this.cancelScheduledViewUpdate();
    this.stopSessionKeepAlive();
    this.currentView.isActive = false;
    this.currentView.documentVersion++;
    // emitViewUpdate must come before viewContext.close(): the final event must be assembled
    // with the current view context still available to the hook.
    this.emitViewUpdate();
    this.viewContext.close();
  }

  private onSessionRenew(): void {
    this.cancelScheduledViewUpdate();
    this.createNewView();
  }

  private onServerRumEvent(event: ServerRumEvent): void {
    const type = event.data.type;
    if (type === 'action' || type === 'error' || type === 'resource') {
      this.currentView.counters[type].count++;
      this.currentView.documentVersion++;
      this.scheduleViewUpdate();
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
}
