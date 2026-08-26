import { app } from 'electron';
import * as path from 'node:path';
import { elapsed, timeStampNow, toServerDuration, type TimeStamp } from '@datadog/js-core/time';
import { generateUUID, type Subscription } from '@datadog/browser-core';
import { SKIPPED } from '@datadog/js-core/assembly';
import type { RecursivePartial } from '@datadog/js-core/util';
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
import type { RawRumExecutionContext, RawRumView, RumEvent } from '../types';
import { setInterval, clearInterval } from '../../telemetry';
import { ViewContext } from '../view';
import { DiskValueHistory } from '../../../tools/DiskValueHistory';
import { PROCESS_UPDATE_INTERVAL } from './constants';

export const MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME = '_dd_execution_context_history';

interface MainExecutionContextEntry {
  id: string;
  type: 'main-process';
}

interface MainProcessPair {
  sessionId: string;
  executionContextId: string;
  startTime: TimeStamp;
  documentVersion: number;
}

/**
 * Owns the fake main-process view and the main execution context as one session-scoped pair:
 * both are created together on SDK init and on every SESSION_RENEW, and closed together on
 * SESSION_EXPIRED. The pair shares one instance_id (the OS process pid) across every session it
 * spans, but gets a fresh execution_context.id and view.id per session. Also registers the format
 * hook that tags every other main-process RUM event with the execution context active at that
 * event's timestamp, backed by a disk-persisted history so a crash file replayed from a previous
 * run still resolves to the context that was active when the crash happened.
 */
export class MainProcessContext {
  private pair!: MainProcessPair;
  private heartbeatId: ReturnType<typeof setInterval> | undefined;
  private lifecycleSubscription!: Subscription;

  private constructor(
    private readonly eventManager: EventManager,
    private readonly viewContext: ViewContext,
    private readonly mainHistory: DiskValueHistory<MainExecutionContextEntry>,
    private readonly sessionManager: SessionManager
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    sessionManager: SessionManager
  ): Promise<MainProcessContext> {
    const viewContext = await ViewContext.init(hooks, undefined, { isExecutionContextEnabled: true });
    const filePath = path.join(app.getPath('userData'), MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME);
    const mainHistory = await DiskValueHistory.init<MainExecutionContextEntry>({
      filePath,
      expireDelay: SESSION_TIME_OUT_DELAY,
    });
    const context = new MainProcessContext(eventManager, viewContext, mainHistory, sessionManager);

    hooks.registerRum(({ source, startTime }) => {
      if (source !== EventSource.MAIN) return SKIPPED;
      const entry = mainHistory.find(startTime);
      if (entry === undefined) return SKIPPED;
      // The generated CommonProperties.execution_context type carries an index signature
      // ([k: string]: unknown) that MainExecutionContextEntry deliberately doesn't — this cast
      // bridges that, not a workaround for execution_context being unknown to the schema.
      return { execution_context: entry } as RecursivePartial<RumEvent>;
    });

    context.startPair();

    context.lifecycleSubscription = eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => {
        if (event.lifecycle === LifecycleKind.SESSION_EXPIRED) {
          context.endPair();
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          context.startPair();
        }
      },
    });

    return context;
  }

  stop(): void {
    this.clearHeartbeat();
    this.lifecycleSubscription.unsubscribe();
  }

  private startPair(): void {
    const startTime = timeStampNow();
    const sessionId = this.sessionManager.getSession().id;
    const executionContextId = generateUUID();
    this.pair = { sessionId, executionContextId, startTime, documentVersion: 1 };

    // Close whatever the previous pair (this run's prior session, or — on the very first call —
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

  private endPair(): void {
    this.clearHeartbeat();
    this.pair.documentVersion++;
    this.emitViewEvent(false);
    this.emitExecutionContextEvent();
  }

  private startHeartbeat(): void {
    this.heartbeatId = setInterval(() => {
      this.pair.documentVersion++;
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
      date: this.pair.startTime,
      view: {
        id: this.pair.sessionId,
        time_spent: toServerDuration(elapsed(this.pair.startTime, timeStampNow())),
        is_active: isActive,
        action: { count: 0 },
        error: { count: 0 },
        resource: { count: 0 },
        is_fake: true,
      },
      _dd: { document_version: this.pair.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data: viewEvent,
      startTime: this.pair.startTime,
    });
  }

  private emitExecutionContextEvent(): void {
    const isStart = this.pair.documentVersion === 1;
    const data: RawRumExecutionContext = {
      type: 'execution_context',
      date: this.pair.startTime,
      execution_context: {
        id: this.pair.executionContextId,
        type: 'main-process',
        instance_id: String(process.pid),
        ...(!isStart && { duration: toServerDuration(elapsed(this.pair.startTime, timeStampNow())) }),
      },
      _dd: { document_version: this.pair.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data,
      startTime: this.pair.startTime,
    });
  }
}
