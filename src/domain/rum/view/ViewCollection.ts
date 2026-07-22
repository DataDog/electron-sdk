import { elapsed, ONE_MINUTE, timeStampNow, toServerDuration, TimeStamp } from '@datadog/js-core/time';
import { Subscription } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, type LifecycleEvent, LifecycleKind } from '../../../event';
import type { FormatHooks } from '../../../assembly';
import { setInterval } from '../../telemetry';
import type { RawRumView } from '../rawRumData.types';
import { ViewContext } from './ViewContext';
import { SessionManager } from '../../session';

export const SESSION_KEEP_ALIVE_INTERVAL = 5 * ONE_MINUTE;

interface ViewState {
  id: string;
  startTime: TimeStamp;
  documentVersion: number;
  isActive: boolean;
}

/**
 * Track the fake main-process view lifecycle.
 * - view.id == session.id (fake view, not a real renderer view)
 * - on creation, emit an initial view event
 * - keep session alive by regularly sending view updates
 *   // TODO: challenge whether keep-alive is still needed once the backend
 *   // uses process heartbeats for session liveness
 * - on SESSION_EXPIRED, emit a final inactive view update
 * - on SESSION_RENEW, create a new view with the new session.id
 */
export class ViewCollection {
  private currentView!: ViewState;
  private viewContext!: ViewContext;
  private keepAliveIntervalId: ReturnType<typeof setInterval> | undefined;
  private lifecycleSubscription!: Subscription;

  constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks,
    private readonly sessionManager: SessionManager
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    sessionManager: SessionManager
  ): Promise<ViewCollection> {
    const collection = new ViewCollection(eventManager, hooks, sessionManager);
    await collection.init();
    return collection;
  }

  private async init(): Promise<void> {
    this.viewContext = await ViewContext.init(this.hooks);
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
  }

  stop(): void {
    this.stopSessionKeepAlive();
    this.lifecycleSubscription.unsubscribe();
  }

  private createNewView(): void {
    const viewId = this.sessionManager.getSession().id;
    this.currentView = {
      id: viewId,
      startTime: timeStampNow(),
      documentVersion: 1,
      isActive: true,
    };

    this.viewContext.close(); // close previous view if any (ensures non-overlapping history entries)
    this.viewContext.add(viewId);
    this.emitViewUpdate();
    this.keepSessionAlive();
  }

  private emitViewUpdate(): void {
    const viewEvent: RawRumView = {
      type: 'view',
      date: this.currentView.startTime,
      view: {
        id: this.currentView.id,
        time_spent: toServerDuration(elapsed(this.currentView.startTime, timeStampNow())),
        is_active: this.currentView.isActive,
        action: { count: 0 },
        error: { count: 0 },
        resource: { count: 0 },
      },
      _dd: { document_version: this.currentView.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data: viewEvent,
      startTime: this.currentView.startTime,
    });
  }

  private onSessionExpired(): void {
    this.stopSessionKeepAlive();
    this.currentView.isActive = false;
    this.currentView.documentVersion++;
    this.emitViewUpdate();
    this.viewContext.close();
  }

  private onSessionRenew(): void {
    this.createNewView();
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
