import { elapsed, ONE_MINUTE, ONE_SECOND, timeStampNow, toServerDuration, TimeStamp } from '@datadog/js-core/time';
import { generateUUID, Subscription } from '@datadog/browser-core';
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
import type { RawRumView } from '../types';
import { ViewContext } from './ViewContext';
import type { TrackingConsent, TrackingConsentChange, TrackingConsentManager } from '../../tracking-consent';

export const SESSION_KEEP_ALIVE_INTERVAL = 5 * ONE_MINUTE;
// throttle view updates to avoid bursts
export const VIEW_UPDATE_THROTTLE_DELAY = 3 * ONE_SECOND;

interface ViewState {
  id: string;
  startTime: TimeStamp;
  documentVersion: number;
  isActive: boolean;
  consent: TrackingConsent;
  counters: { action: { count: number }; error: { count: number }; resource: { count: number } };
}

/**
 * Tracks the main view while consent is granted or pending.
 * - on creation, emit an initial view event
 * - keep session alive by regularly send view updates
 * - on SESSION_EXPIRED, emit a final inactive view update
 * - on SESSION_RENEW, create a new view
 * - on consent changes, close the cumulative view and replace it unless consent is refused
 * - on main-process RUM server event (error, resource), increment view counters (throttled)
 */
export class ViewCollection {
  private currentView: ViewState | undefined;
  private viewContext!: ViewContext;
  private keepAliveIntervalId: ReturnType<typeof setInterval> | undefined;
  private scheduleViewUpdate!: () => void;
  private cancelScheduledViewUpdate!: () => void;
  private lifecycleSubscription!: Subscription;
  private serverEventSubscription!: Subscription;
  private consentSubscription!: Subscription;

  constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks,
    private readonly trackingConsentManager: TrackingConsentManager
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    trackingConsentManager: TrackingConsentManager
  ): Promise<ViewCollection> {
    const collection = new ViewCollection(eventManager, hooks, trackingConsentManager);
    await collection.init();
    return collection;
  }

  private async init(): Promise<void> {
    const { throttled, cancel } = throttle(() => this.emitViewUpdate(), VIEW_UPDATE_THROTTLE_DELAY);
    this.scheduleViewUpdate = throttled;
    this.cancelScheduledViewUpdate = cancel;

    this.viewContext = await ViewContext.init(this.hooks);
    if (this.trackingConsentManager.get() !== 'not-granted') {
      this.createNewView();
    } else {
      this.viewContext.close();
    }

    this.lifecycleSubscription = this.eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => {
        if (event.lifecycle === LifecycleKind.SESSION_EXPIRED) {
          this.closeCurrentView(event.time);
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          this.onSessionRenew(event.time);
        }
      },
    });

    this.serverEventSubscription = this.eventManager.registerHandler<ServerRumEvent>({
      canHandle: (event): event is ServerRumEvent => event.kind === EventKind.SERVER && event.track === EventTrack.RUM,
      handle: (event) => this.onServerRumEvent(event),
    });
    this.consentSubscription = this.trackingConsentManager.subscribe((change) => this.onConsentChange(change));
  }

  stop(): void {
    this.cancelScheduledViewUpdate();
    this.stopSessionKeepAlive();
    this.lifecycleSubscription.unsubscribe();
    this.serverEventSubscription.unsubscribe();
    this.consentSubscription.unsubscribe();
  }

  private createNewView(atTime: TimeStamp = timeStampNow()): void {
    const viewId = generateUUID();
    this.currentView = {
      id: viewId,
      startTime: atTime,
      documentVersion: 1,
      isActive: true,
      consent: this.trackingConsentManager.get(),
      counters: { action: { count: 0 }, error: { count: 0 }, resource: { count: 0 } },
    };

    // Use the event timestamp for both history boundaries. A later clock reading
    // could make this view event predate its own history entry and get discarded.
    this.viewContext.add(viewId, this.currentView.startTime);
    this.emitViewUpdate();
    this.keepSessionAlive();
  }

  private emitViewUpdate(atTime: TimeStamp = timeStampNow()): void {
    if (!this.currentView) {
      return;
    }
    const viewEvent: RawRumView = {
      type: 'view',
      date: this.currentView.startTime,
      view: {
        id: this.currentView.id,
        time_spent: toServerDuration(elapsed(this.currentView.startTime, atTime)),
        is_active: this.currentView.isActive,
        ...this.currentView.counters,
      },
      _dd: { document_version: this.currentView.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data: viewEvent,
      startTime: this.currentView.startTime,
      ...(!this.currentView.isActive && this.currentView.consent === 'granted'
        ? { storageConsent: 'granted' as const }
        : {}),
    });
  }

  private closeCurrentView(atTime: TimeStamp = timeStampNow()): void {
    if (!this.currentView?.isActive) {
      return;
    }

    this.cancelScheduledViewUpdate();
    this.stopSessionKeepAlive();
    this.currentView.isActive = false;
    this.currentView.documentVersion++;
    this.emitViewUpdate(atTime);
    this.viewContext.close(atTime);
  }

  private onSessionRenew(atTime?: TimeStamp): void {
    if (this.trackingConsentManager.get() === 'not-granted') {
      return;
    }
    this.cancelScheduledViewUpdate();
    this.createNewView(atTime);
  }

  private onConsentChange(change: TrackingConsentChange): void {
    // Session renewal may already have created a view under the new consent.
    if (this.currentView?.isActive && this.currentView.consent === change.current) {
      return;
    }
    this.closeCurrentView(change.time);
    if (change.current !== 'not-granted') {
      this.createNewView(change.time);
    }
  }

  private onServerRumEvent(event: ServerRumEvent): void {
    if (event.source === EventSource.RENDERER || !this.currentView?.isActive) {
      return;
    }

    const type = event.data.type;
    if ((type === 'error' || type === 'resource') && event.data.view.id === this.currentView.id) {
      this.currentView.counters[type].count++;
      this.currentView.documentVersion++;
      this.scheduleViewUpdate();
    }
  }

  private keepSessionAlive(): void {
    this.stopSessionKeepAlive();
    this.keepAliveIntervalId = setInterval(() => {
      if (!this.currentView?.isActive) {
        return;
      }
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
