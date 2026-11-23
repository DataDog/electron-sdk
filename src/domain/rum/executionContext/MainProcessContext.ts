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
import { FakeViewContext } from './FakeViewContext';
import { DiskValueHistory } from '../../../tools/DiskValueHistory';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';

export const MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME = '_dd_execution_context_history';

const MAIN_PROCESS_EXECUTION_CONTEXT_NAME = 'Main Process';

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
 * Owns a fake main-process view and execution context for each tracked RUM session.
 * Both histories close on session expiry. Each tracked session gets a fresh execution_context.id, while the emitted
 * execution_context event's instance_id is always the OS process pid, constant across every session
 * the process lives through. Also registers the format hooks that tag every other main-process RUM
 * event, log and span with the execution context active at that event's timestamp, backed by a
 * disk-persisted history so a crash file replayed from a previous run still resolves to the
 * context that was active when the crash happened.
 */
export class MainProcessContext {
  private state: MainProcessState | undefined;
  private heartbeatId: ReturnType<typeof setInterval> | undefined;
  private lifecycleSubscription!: Subscription;

  private constructor(
    private readonly eventManager: EventManager,
    private readonly fakeViewContext: FakeViewContext,
    private readonly mainHistory: DiskValueHistory<MainExecutionContextDiskEntry>,
    private readonly sessionManager: SessionManager
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    sessionManager: SessionManager
  ): Promise<MainProcessContext> {
    const fakeViewContext = await FakeViewContext.init(hooks);
    const filePath = path.join(app.getPath('userData'), MAIN_EXECUTION_CONTEXT_HISTORY_FILE_NAME);
    const mainHistory = await DiskValueHistory.init<MainExecutionContextDiskEntry>({
      filePath,
      expireDelay: SESSION_TIME_OUT_DELAY,
    });
    const context = new MainProcessContext(eventManager, fakeViewContext, mainHistory, sessionManager);

    const getExecutionContext = (startTime: TimeStamp) => {
      const entry = mainHistory.find(startTime);
      if (entry === undefined) return SKIPPED;
      return { execution_context: { id: entry.id, type: entry.type, name: MAIN_PROCESS_EXECUTION_CONTEXT_NAME } };
    };

    hooks.registerRum(({ source, eventType, startTime }) => {
      // execution_context events (main's own and every renderer's) are fully self-authored —
      // this hook only tags *other* event types with the context active at their own startTime.
      // Without this, combine() lets this hook's name fill in for a renderer's still-unresolved
      // (undefined) one, since both this event and the renderer's own reach here with source
      // MAIN — RendererProcessContexts's own tagging code also runs in the main process.
      if (source !== EventSource.MAIN || eventType === 'execution_context') return SKIPPED;
      return getExecutionContext(startTime);
    });

    hooks.registerLogs(({ source, startTime }) => {
      if (source !== EventSource.MAIN) return SKIPPED;
      return getExecutionContext(startTime);
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
    // Close a previous run's active histories even if this session is not tracked.
    const startTime = timeStampNow();
    this.fakeViewContext.close(startTime);
    this.mainHistory.closeActive(startTime);

    const sessionId = this.sessionManager.getTrackedSessionId(startTime);
    if (!sessionId) return;

    // Both histories share one timestamp so their events can resolve each other.
    const executionContextId = generateUUID();
    const state: MainProcessState = { sessionId, executionContextId, startTime, documentVersion: 1 };
    this.state = state;
    this.fakeViewContext.add(sessionId, startTime);
    this.mainHistory.add({ id: executionContextId, type: 'main-process' }, startTime);

    this.emitViewEvent(state, true);
    this.emitExecutionContextEvent(state);
    this.startHeartbeat(state);
  }

  private endState(): void {
    this.clearHeartbeat();
    const state = this.state;
    if (!state) return;
    // Close both histories at the exact same instant (same reasoning as startState's shared
    // startTime): otherwise main-process telemetry timestamped in the gap before the next
    // SESSION_RENEW would still resolve to this now-expired state.
    const endTime = timeStampNow();
    this.fakeViewContext.close(endTime);
    this.mainHistory.closeActive(endTime);
    state.documentVersion++;
    this.emitViewEvent(state, false);
    this.emitExecutionContextEvent(state);
    this.state = undefined;
  }

  private startHeartbeat(state: MainProcessState): void {
    this.heartbeatId = setInterval(() => {
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

  private emitViewEvent(state: MainProcessState, isActive: boolean): void {
    const viewEvent: RawRumView = {
      type: 'view',
      date: state.startTime,
      view: {
        // use session id for fake view id
        id: state.sessionId,
        is_fake: true,
        time_spent: toServerDuration(elapsed(state.startTime, timeStampNow())),
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
    });
  }

  private emitExecutionContextEvent(state: MainProcessState): void {
    const data: RawRumExecutionContext = {
      type: 'execution_context',
      date: state.startTime,
      execution_context: {
        id: state.executionContextId,
        type: 'main-process',
        name: MAIN_PROCESS_EXECUTION_CONTEXT_NAME,
        instance_id: String(process.pid),
        duration: toServerDuration(elapsed(state.startTime, timeStampNow())),
      },
      _dd: { document_version: state.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data,
      startTime: state.startTime,
    });
  }
}
