import { elapsed, timeStampNow, toServerDuration, type TimeStamp } from '@datadog/js-core/time';
import { generateUUID, type Subscription } from '@datadog/browser-core';
import { DISCARDED, SKIPPED } from '@datadog/js-core/assembly';
import {
  EventFormat,
  EventKind,
  EventSource,
  type EventManager,
  type LifecycleEvent,
  LifecycleKind,
} from '../../../event';
import type { FormatHooks } from '../../../assembly';
import { SESSION_TIME_OUT_DELAY, type SessionManager } from '../../session';
import type { RawRumExecutionContext, RawRumView } from '../types';
import { setInterval, clearInterval } from '../../telemetry';
import { ViewContext } from '../view';
import {
  type TrackingConsentHistory,
  type ContextHistoryFactory,
  type TrackingConsent,
  type TrackingConsentChange,
  type TrackingConsentManager,
} from '../../tracking-consent';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';

export const MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME = '_dd_execution_context_history';

const MAIN_PROCESS_EXECUTION_CONTEXT_NAME = 'Main Process';

interface MainExecutionContextDiskEntry {
  id: string;
  type: 'main-process';
}

interface MainProcessState {
  sessionId: string;
  viewId: string;
  executionContextId: string;
  startTime: TimeStamp;
  documentVersion: number;
  consent: TrackingConsent;
  isActive: boolean;
}

/**
 * Owns the fake main-process view and main execution context for each session and consent period.
 * Both start and end together at session and consent boundaries, and stay inactive while denied.
 * Each new state gets a fresh execution_context.id and view.id, but the emitted
 * execution_context event's instance_id is always the OS process pid, constant across every session
 * the process lives through. Also registers the format hooks that tag every other main-process RUM
 * event and span with the execution context active at that event's timestamp, using
 * authorized history retained from the current and previous process. Consent changes close cumulative periods;
 * denied consent leaves no active state or heartbeat.
 */
export class MainProcessContext {
  private state: MainProcessState | undefined;
  private heartbeatId: ReturnType<typeof setInterval> | undefined;
  private lifecycleSubscription!: Subscription;
  private consentSubscription!: Subscription;

  private constructor(
    private readonly eventManager: EventManager,
    private readonly viewContext: ViewContext,
    private readonly mainHistory: TrackingConsentHistory<MainExecutionContextDiskEntry>,
    private readonly sessionManager: SessionManager,
    private readonly consentManager: TrackingConsentManager
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    sessionManager: SessionManager,
    histories: ContextHistoryFactory,
    trackingConsentManager: TrackingConsentManager
  ): Promise<MainProcessContext> {
    const viewContext = await ViewContext.init(hooks, histories, undefined, {
      isExecutionContextEnabled: true,
    });
    const mainHistory = await histories.create<MainExecutionContextDiskEntry>(
      MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME,
      SESSION_TIME_OUT_DELAY
    );
    const context = new MainProcessContext(
      eventManager,
      viewContext,
      mainHistory,
      sessionManager,
      trackingConsentManager
    );

    hooks.registerRum(({ source, eventType, startTime }) => {
      // execution_context events (main's own and every renderer's) are fully self-authored —
      // this hook only tags *other* event types with the context active at their own startTime.
      // Without this, combine() lets this hook's name fill in for a renderer's still-unresolved
      // (undefined) one, since both this event and the renderer's own reach here with source
      // MAIN — RendererProcessContexts's own tagging code also runs in the main process.
      if (source !== EventSource.MAIN || eventType === 'execution_context') return SKIPPED;
      const entry = mainHistory.find(startTime);
      if (entry === undefined) return SKIPPED;
      return { execution_context: { id: entry.id, type: entry.type, name: MAIN_PROCESS_EXECUTION_CONTEXT_NAME } };
    });

    hooks.registerSpan(({ startTime }) => {
      const entry = mainHistory.find(startTime);
      if (entry === undefined) return DISCARDED;
      return { meta: { '_dd.execution_context.id': entry.id } };
    });

    context.startState();

    context.lifecycleSubscription = eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => {
        if (event.lifecycle === LifecycleKind.SESSION_EXPIRED) {
          context.endState(event.time);
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          context.startState(event.time);
        }
      },
    });
    context.consentSubscription = trackingConsentManager.subscribe((change) => context.onConsentChange(change));

    return context;
  }

  stop(): void {
    this.clearHeartbeat();
    this.lifecycleSubscription.unsubscribe();
    this.consentSubscription.unsubscribe();
  }

  private startState(startTime = timeStampNow()): void {
    const consent = this.consentManager.get();
    if (consent === 'not-granted') return;
    this.clearHeartbeat();
    // One shared startTime for every registration below: the view and execution_context events
    // cross-tag each other by looking up the other's history at their own startTime, so
    // both entries must be registered at the exact same instant — two independent timeStampNow()
    // reads, even microseconds apart, could land on opposite sides of a lookup boundary and miss.
    const sessionId = this.sessionManager.getSession().id;
    // A consent split needs a distinct view document even when the session is unchanged.
    const viewId = this.state?.sessionId === sessionId ? generateUUID() : sessionId;
    const executionContextId = generateUUID();
    this.state = { sessionId, viewId, executionContextId, startTime, documentVersion: 1, consent, isActive: true };

    // Close whatever the previous state (this run's prior session, or — on the very first call —
    // whatever a previous, since-exited process instance left open) left active, before
    // registering this one. Safe to call unconditionally: closing an already-closed entry is a
    // no-op.
    this.viewContext.add(viewId, startTime);
    this.mainHistory.set({ id: executionContextId, type: 'main-process' }, startTime);

    this.emitViewEvent(this.state, true, startTime);
    this.emitExecutionContextEvent(this.state, startTime);
    this.startHeartbeat();
  }

  private endState(endTime = timeStampNow()): void {
    if (!this.state?.isActive) return;
    this.clearHeartbeat();
    // Close both histories at the exact same instant (same reasoning as startState's shared
    // startTime): otherwise main-process telemetry timestamped in the gap before the next
    // SESSION_RENEW would still resolve to this now-expired state.
    this.viewContext.close(endTime);
    this.mainHistory.set(undefined, endTime);
    this.state.documentVersion++;
    this.state.isActive = false;
    this.emitViewEvent(this.state, false, endTime);
    this.emitExecutionContextEvent(this.state, endTime);
  }

  private onConsentChange(change: TrackingConsentChange): void {
    // Session renewal can already have started this consent period synchronously.
    if (this.state?.isActive && this.state.consent === change.current) return;
    this.endState(change.time);
    if (change.current !== 'not-granted') this.startState(change.time);
  }

  private startHeartbeat(): void {
    this.heartbeatId = setInterval(() => {
      const state = this.state!;
      state.documentVersion++;
      this.emitExecutionContextEvent(state);
    }, PROCESS_UPDATE_INTERVAL);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatId !== undefined) {
      clearInterval(this.heartbeatId);
      this.heartbeatId = undefined;
    }
  }

  private emitViewEvent(state: MainProcessState, isActive: boolean, atTime = timeStampNow()): void {
    const viewEvent: RawRumView = {
      type: 'view',
      date: state.startTime,
      view: {
        id: state.viewId,
        is_fake: true,
        time_spent: toServerDuration(elapsed(state.startTime, atTime)),
        is_active: isActive,
        action: { count: 0 },
        error: { count: 0 },
        resource: { count: 0 },
      },
      _dd: { document_version: state.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data: viewEvent,
      startTime: state.startTime,
      ...(!state.isActive && state.consent === 'granted' ? { storageConsent: 'granted' as const } : {}),
    });
  }

  private emitExecutionContextEvent(state: MainProcessState, atTime = timeStampNow()): void {
    const data: RawRumExecutionContext = {
      type: 'execution_context',
      date: state.startTime,
      execution_context: {
        id: state.executionContextId,
        type: 'main-process',
        name: MAIN_PROCESS_EXECUTION_CONTEXT_NAME,
        instance_id: String(process.pid),
        duration: toServerDuration(elapsed(state.startTime, atTime)),
      },
      _dd: { document_version: state.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data,
      startTime: state.startTime,
      ...(!state.isActive && state.consent === 'granted' ? { storageConsent: 'granted' as const } : {}),
    });
  }
}
