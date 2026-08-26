import { app } from 'electron';
import { elapsed, timeStampNow, toServerDuration, type TimeStamp } from '@datadog/js-core/time';
import { generateUUID, type Subscription } from '@datadog/browser-core';
import { SKIPPED } from '@datadog/js-core/assembly';
import {
  EventFormat,
  EventKind,
  EventSource,
  type EventManager,
  type LifecycleEvent,
  LifecycleKind,
} from '../../../event';
import type { FormatHooks } from '../../../assembly';
import { monitor, setInterval, clearInterval } from '../../telemetry';
import type { SessionManager } from '../../session';
import type { RawRumExecutionContext } from '../types';
import { PROCESS_UPDATE_INTERVAL } from './constants';
import { MainProcessContext } from './MainProcessContext';

type ExecutionContextExitReason = RawRumExecutionContext['execution_context']['exit_reason'];

interface ExecutionContextState {
  id: string;
  type: 'renderer-process';
  startTime: TimeStamp;
  documentVersion: number;
  instanceId: string;
  parentInstanceId?: string;
  timerId: ReturnType<typeof setInterval>;
}

/**
 * Owns the whole execution-context feature: composes a session-scoped MainProcessContext for the
 * main process, and independently tracks renderer-process lifecycle — one context per webContents,
 * created at 'web-contents-created', rotated on every SESSION_EXPIRED (closed, no exit_reason —
 * the process is still alive) / SESSION_RENEW (reopened, new id, same instance_id) pair, and ended
 * at 'destroyed' / 'render-process-gone' (with a real exit_reason). Registers its own format hook
 * that tags renderer-sourced RUM events straight from its own rendererStates map — main-process
 * tagging is MainProcessContext's own, separate hook.
 */
export class ExecutionContextCollection {
  private readonly rendererStates = new Map<number, ExecutionContextState>();
  private lifecycleSubscription!: Subscription;
  private mainProcessContext!: MainProcessContext;
  private readonly onWebContentsCreated = monitor((_event: Electron.Event, webContents: Electron.WebContents) => {
    const webContentsId = webContents.id;
    const id = generateUUID();

    const state: ExecutionContextState = {
      id,
      type: 'renderer-process',
      startTime: timeStampNow(),
      documentVersion: 1,
      instanceId: String(webContents.getProcessId()),
      parentInstanceId: String(process.pid),
      timerId: setInterval(() => {
        const current = this.rendererStates.get(webContentsId);
        if (!current) {
          return;
        }
        current.documentVersion++;
        this.emitExecutionContextEvent(current);
      }, PROCESS_UPDATE_INTERVAL),
    };
    this.rendererStates.set(webContentsId, state);

    this.emitExecutionContextEvent(state);

    const endRenderer = (exitReason?: ExecutionContextExitReason) => {
      const s = this.rendererStates.get(webContentsId);
      if (!s) {
        return;
      }
      clearInterval(s.timerId);
      s.documentVersion++;
      this.emitExecutionContextEvent(s, exitReason);
      this.rendererStates.delete(webContentsId);
    };

    webContents.on(
      'destroyed',
      monitor(() => endRenderer(undefined))
    );
    webContents.on(
      'render-process-gone',
      monitor((_e, details) => endRenderer(details.reason))
    );
  });

  private constructor(private readonly eventManager: EventManager) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    sessionManager: SessionManager
  ): Promise<ExecutionContextCollection> {
    const collection = new ExecutionContextCollection(eventManager);

    hooks.registerRum(({ source, webContentsId }) => {
      if (source !== EventSource.RENDERER) return SKIPPED;
      const state = webContentsId === undefined ? undefined : collection.rendererStates.get(webContentsId);
      if (state === undefined) return SKIPPED;
      return { execution_context: { id: state.id, type: state.type } };
    });

    collection.mainProcessContext = await MainProcessContext.start(eventManager, hooks, sessionManager);
    collection.initRendererTracking();
    return collection;
  }

  stop(): void {
    this.mainProcessContext.stop();
    app.removeListener('web-contents-created', this.onWebContentsCreated);
    for (const state of this.rendererStates.values()) {
      clearInterval(state.timerId);
    }
    this.lifecycleSubscription.unsubscribe();
  }

  private initRendererTracking(): void {
    // web-contents-created and the per-webContents listeners below all come from Electron, not from
    // our own event pipeline — each is wrapped in monitor() so a bug here can't crash the host app
    // or leave one of Electron's own emitters in a broken state; errors still surface via telemetry.
    app.on('web-contents-created', this.onWebContentsCreated);

    this.lifecycleSubscription = this.eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => {
        if (event.lifecycle === LifecycleKind.SESSION_EXPIRED) {
          this.closeAllRenderersForSessionExpiry();
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          this.reopenAllRenderersForSessionRenewal();
        }
      },
    });
  }

  private closeAllRenderersForSessionExpiry(): void {
    for (const state of this.rendererStates.values()) {
      clearInterval(state.timerId);
      state.documentVersion++;
      this.emitExecutionContextEvent(state);
    }
  }

  private reopenAllRenderersForSessionRenewal(): void {
    for (const [webContentsId, previous] of this.rendererStates) {
      const id = generateUUID();

      const state: ExecutionContextState = {
        id,
        type: 'renderer-process',
        startTime: timeStampNow(),
        documentVersion: 1,
        instanceId: previous.instanceId,
        parentInstanceId: previous.parentInstanceId,
        timerId: setInterval(() => {
          const current = this.rendererStates.get(webContentsId);
          if (!current) {
            return;
          }
          current.documentVersion++;
          this.emitExecutionContextEvent(current);
        }, PROCESS_UPDATE_INTERVAL),
      };
      this.rendererStates.set(webContentsId, state);

      this.emitExecutionContextEvent(state);
    }
  }

  private emitExecutionContextEvent(state: ExecutionContextState, exitReason?: ExecutionContextExitReason): void {
    const isStart = state.documentVersion === 1;
    const data: RawRumExecutionContext = {
      type: 'execution_context',
      date: state.startTime,
      execution_context: {
        id: state.id,
        type: state.type,
        instance_id: state.instanceId,
        ...(state.parentInstanceId !== undefined && { parent_instance_id: state.parentInstanceId }),
        ...(!isStart && { duration: toServerDuration(elapsed(state.startTime, timeStampNow())) }),
        ...(exitReason !== undefined && { exit_reason: exitReason }),
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
