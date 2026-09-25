import { app } from 'electron';
import * as path from 'node:path';
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
import { DiskValueHistory } from '../../../tools/DiskValueHistory';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';

export const MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME = '_dd_execution_context_history';

interface MainExecutionContextDiskEntry {
  id: string;
  type: 'main-process';
}

interface MainProcessState {
  sessionId: string;
  executionContextId: string;
  startTime: TimeStamp;
  documentVersion: number;
}

/**
 * Owns the fake main-process view and the main execution context as one session-scoped state:
 * both are created together on SDK init and on every SESSION_RENEW, and closed together on
 * SESSION_EXPIRED. Each new state gets a fresh execution_context.id and view.id, but the emitted
 * execution_context event's instance_id is always the OS process pid, constant across every session
 * the process lives through. Also registers the format hooks that tag every other main-process RUM
 * event and span with the execution context active at that event's timestamp, backed by a
 * disk-persisted history so a crash file replayed from a previous run still resolves to the
 * context that was active when the crash happened.
 */
export class MainProcessContext {
  private state!: MainProcessState;
  private heartbeatId: ReturnType<typeof setInterval> | undefined;
  private lifecycleSubscription!: Subscription;

  private constructor(
    private readonly eventManager: EventManager,
    private readonly viewContext: ViewContext,
    private readonly mainHistory: DiskValueHistory<MainExecutionContextDiskEntry>,
    private readonly sessionManager: SessionManager
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    sessionManager: SessionManager
  ): Promise<MainProcessContext> {
    const viewContext = await ViewContext.init(hooks, undefined, { isExecutionContextEnabled: true });
    const filePath = path.join(app.getPath('userData'), MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME);
    const mainHistory = await DiskValueHistory.init<MainExecutionContextDiskEntry>({
      filePath,
      expireDelay: SESSION_TIME_OUT_DELAY,
    });
    const context = new MainProcessContext(eventManager, viewContext, mainHistory, sessionManager);

    hooks.registerRum(({ source, startTime }) => {
      if (source !== EventSource.MAIN) return SKIPPED;
      const entry = mainHistory.find(startTime);
      if (entry === undefined) return SKIPPED;
      return { execution_context: { id: entry.id, type: entry.type } };
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
          context.endState();
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          context.startState();
        }
      },
    });

    return context;
  }

  stop(): void {
    this.clearHeartbeat();
    this.lifecycleSubscription.unsubscribe();
  }

  private startState(): void {
    // One shared startTime for every registration below: the view and execution_context events
    // cross-tag each other by looking up the other's DiskValueHistory at their own startTime, so
    // both entries must be registered at the exact same instant — two independent timeStampNow()
    // reads, even microseconds apart, could land on opposite sides of a lookup boundary and miss.
    const startTime = timeStampNow();
    const sessionId = this.sessionManager.getSession().id;
    const executionContextId = generateUUID();
    this.state = { sessionId, executionContextId, startTime, documentVersion: 1 };

    // Close whatever the previous state (this run's prior session, or — on the very first call —
    // whatever a previous, since-exited process instance left open) left active, before
    // registering this one. Safe to call unconditionally: closing an already-closed entry is a
    // no-op.
    this.viewContext.close(startTime);
    this.viewContext.add(sessionId, startTime);
    this.mainHistory.closeActive(startTime);
    this.mainHistory.add({ id: executionContextId, type: 'main-process' }, startTime);

    this.emitViewEvent(true);
    this.emitExecutionContextEvent();
    this.startHeartbeat();
  }

  private endState(): void {
    this.clearHeartbeat();
    // Close both histories at the exact same instant (same reasoning as startState's shared
    // startTime): otherwise main-process telemetry timestamped in the gap before the next
    // SESSION_RENEW would still resolve to this now-expired state.
    const endTime = timeStampNow();
    this.viewContext.close(endTime);
    this.mainHistory.closeActive(endTime);
    this.state.documentVersion++;
    this.emitViewEvent(false);
    this.emitExecutionContextEvent();
  }

  private startHeartbeat(): void {
    this.heartbeatId = setInterval(() => {
      this.state.documentVersion++;
      this.emitExecutionContextEvent();
    }, PROCESS_UPDATE_INTERVAL);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatId !== undefined) {
      clearInterval(this.heartbeatId);
      this.heartbeatId = undefined;
    }
  }

  private emitViewEvent(isActive: boolean): void {
    const viewEvent: RawRumView = {
      type: 'view',
      date: this.state.startTime,
      view: {
        // use session id for fake view id
        id: this.state.sessionId,
        is_fake: true,
        time_spent: toServerDuration(elapsed(this.state.startTime, timeStampNow())),
        is_active: isActive,
        action: { count: 0 },
        error: { count: 0 },
        resource: { count: 0 },
      },
      _dd: { document_version: this.state.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data: viewEvent,
      startTime: this.state.startTime,
    });
  }

  private emitExecutionContextEvent(): void {
    const data: RawRumExecutionContext = {
      type: 'execution_context',
      date: this.state.startTime,
      execution_context: {
        id: this.state.executionContextId,
        type: 'main-process',
        instance_id: String(process.pid),
        duration: toServerDuration(elapsed(this.state.startTime, timeStampNow())),
      },
      _dd: { document_version: this.state.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data,
      startTime: this.state.startTime,
    });
  }
}
