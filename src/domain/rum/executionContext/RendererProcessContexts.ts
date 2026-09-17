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
import type { RawRumExecutionContext } from '../types';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';

type ExecutionContextExitReason = RawRumExecutionContext['execution_context']['exit_reason'];

interface RendererProcessState {
  id: string;
  type: 'renderer-process';
  startTime: TimeStamp;
  documentVersion: number;
  instanceId: string;
  parentInstanceId?: string;
  timerId: ReturnType<typeof setInterval>;
  // Set once this context's session-boundary final update has been emitted (SESSION_EXPIRED),
  // while the process itself is still alive and the state is kept around only so RUM events
  // arriving during the sessionless gap can still resolve it. A real destroy afterward must not
  // mutate this already-closed record — see endRenderer.
  closedForSessionExpiry?: boolean;
}

/**
 * Tracks renderer-process lifecycle — one execution context per webContents, created at
 * 'web-contents-created', rotated on every SESSION_EXPIRED (closed, no exit_reason — the process
 * is still alive) / SESSION_RENEW (reopened, new id, same instance_id) pair, and ended at
 * 'destroyed' ('clean-exit') / 'render-process-gone' (the real crash/kill/OOM reason). Registers
 * its own format hook that tags renderer-sourced RUM events straight from its own rendererStates
 * map — main-process tagging is MainProcessContext's own, separate hook. Composed alongside
 * MainProcessContext by ExecutionContextCollection, which owns neither's internals.
 */
export class RendererProcessContexts {
  private readonly rendererStates = new Map<number, RendererProcessState>();
  private lifecycleSubscription!: Subscription;

  private constructor(private readonly eventManager: EventManager) {}

  static start(eventManager: EventManager, hooks: FormatHooks): RendererProcessContexts {
    const collection = new RendererProcessContexts(eventManager);

    hooks.registerRum(({ source, webContentsId }) => {
      if (source !== EventSource.RENDERER) return SKIPPED;
      const state = webContentsId === undefined ? undefined : collection.rendererStates.get(webContentsId);
      if (state === undefined) return SKIPPED;
      return { execution_context: { id: state.id, type: state.type } };
    });

    collection.initRendererTracking();
    return collection;
  }

  private readonly onWebContentsCreated = monitor((_event: Electron.Event, webContents: Electron.WebContents) => {
    const webContentsId = webContents.id;
    const id = generateUUID();

    const state: RendererProcessState = {
      id,
      type: 'renderer-process',
      startTime: timeStampNow(),
      documentVersion: 1,
      // webContentsId rather than a process id: execution_context is really about which
      // webContents an event came from, not which OS process. webContentsId is assigned once, is
      // always available synchronously, and never changes for this webContents' lifetime — unlike
      // a process id, which Electron can share across multiple webContents in one pooled renderer
      // process. The schema's own instance_id doc comment allows exactly this
      // ("e.g. OS PID, thread ID, tab ID").
      instanceId: String(webContentsId),
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
      const state = this.rendererStates.get(webContentsId);
      if (!state) {
        return;
      }
      clearInterval(state.timerId);
      this.rendererStates.delete(webContentsId);
      if (state.closedForSessionExpiry) {
        // Already emitted this context's terminal update at the session boundary — a destroy
        // arriving during the sessionless gap must stop tagging but not mutate that already-closed
        // record with a bumped document_version/duration/exit_reason.
        return;
      }
      state.documentVersion++;
      this.emitExecutionContextEvent(state, exitReason);
    };

    webContents.on(
      'destroyed',
      monitor(() => endRenderer('clean-exit'))
    );
    webContents.on(
      'render-process-gone',
      monitor((_e, details) => endRenderer(details.reason))
    );
  });

  stop(): void {
    app.removeListener('web-contents-created', this.onWebContentsCreated);
    for (const state of this.rendererStates.values()) {
      clearInterval(state.timerId);
    }
    this.lifecycleSubscription.unsubscribe();
  }

  private initRendererTracking(): void {
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
      state.closedForSessionExpiry = true;
      this.emitExecutionContextEvent(state);
    }
  }

  private reopenAllRenderersForSessionRenewal(): void {
    for (const [webContentsId, previousState] of this.rendererStates) {
      const id = generateUUID();

      const timerId = setInterval(() => {
        const current = this.rendererStates.get(webContentsId);
        if (!current) {
          return;
        }
        current.documentVersion++;
        this.emitExecutionContextEvent(current);
      }, PROCESS_UPDATE_INTERVAL);

      const state: RendererProcessState = {
        id,
        type: 'renderer-process',
        startTime: timeStampNow(),
        documentVersion: 1,
        instanceId: previousState.instanceId,
        parentInstanceId: previousState.parentInstanceId,
        timerId,
      };
      this.rendererStates.set(webContentsId, state);

      this.emitExecutionContextEvent(state);
    }
  }

  private emitExecutionContextEvent(state: RendererProcessState, exitReason?: ExecutionContextExitReason): void {
    const data: RawRumExecutionContext = {
      type: 'execution_context',
      date: state.startTime,
      execution_context: {
        id: state.id,
        type: state.type,
        instance_id: state.instanceId,
        parent_instance_id: state.parentInstanceId,
        duration: toServerDuration(elapsed(state.startTime, timeStampNow())),
        exit_reason: exitReason,
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
