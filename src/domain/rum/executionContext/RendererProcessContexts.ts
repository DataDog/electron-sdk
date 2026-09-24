import { app, webContents as webContentsModule } from 'electron';
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
import { SESSION_TIME_OUT_DELAY } from '../../session';
import { TimeStampValueHistory } from '../../../tools/TimeStampValueHistory';
import type { RawRumExecutionContext } from '../types';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';

type ExecutionContextExitReason = RawRumExecutionContext['execution_context']['exit_reason'];
interface RendererHistoryEntry {
  id: string;
  type: 'renderer-process';
}

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
 * 'web-contents-created' (plus a backfill at start for any webContents already existing, e.g. a
 * deferred init() called after a window opened), rotated on every SESSION_EXPIRED (closed, no
 * exit_reason — the process is still alive) / SESSION_RENEW (reopened, new id, same instance_id)
 * pair, and ended at 'destroyed' ('clean-exit') / 'render-process-gone' (the real crash/kill/OOM
 * reason). Registers its own format hook that tags renderer-sourced RUM events by resolving each
 * webContentsId's timestamped history at the event's own startTime — not just current state — so
 * an event delivered after a rotation but timestamped before it still resolves to the context that
 * was actually active then. Main-process tagging is MainProcessContext's own, separate hook.
 * Composed alongside MainProcessContext by ExecutionContextCollection, which owns neither's
 * internals.
 */
interface AttachedListeners {
  webContents: Electron.WebContents;
  destroyed: () => void;
  processGone: (event: Electron.Event, details: Electron.RenderProcessGoneDetails) => void;
}

export class RendererProcessContexts {
  private readonly rendererStates = new Map<number, RendererProcessState>();
  // Timestamped history per webContentsId, resolved by the RUM hook below via find(startTime) —
  // rendererStates alone only tells you the CURRENT context, which mistags a renderer event whose
  // startTime predates a since-happened SESSION_EXPIRED/SESSION_RENEW rotation (e.g. a browser-sdk
  // event delivered late, or a request that straddles a session boundary during a long idle gap).
  private readonly rendererHistories = new Map<number, TimeStampValueHistory<RendererHistoryEntry>>();
  // Tracks the exact listener functions currently attached per webContents, so a revival (see
  // registerWebContents) can remove the previous cycle's listeners before attaching fresh ones,
  // instead of leaking a pair of stale (but harmless, since endRenderer is idempotent) listeners
  // on every crash/reload cycle a long-running renderer window goes through.
  private readonly attachedListeners = new Map<number, AttachedListeners>();
  // Tracks the pending 'did-start-navigation' revival callback per webContents, so a second crash
  // before the first pending reload ever starts navigating replaces it instead of stacking another
  // one — otherwise both would eventually fire, registering the same webContents twice and
  // orphaning the first call's timer (its map entry gets overwritten by the second before it's ever
  // cleared).
  private readonly pendingRevivals = new Map<
    number,
    (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => void
  >();
  private lifecycleSubscription!: Subscription;

  private constructor(private readonly eventManager: EventManager) {}

  static start(eventManager: EventManager, hooks: FormatHooks): RendererProcessContexts {
    const collection = new RendererProcessContexts(eventManager);

    hooks.registerRum(({ source, webContentsId, startTime }) => {
      if (source !== EventSource.RENDERER) return SKIPPED;
      const history = webContentsId === undefined ? undefined : collection.rendererHistories.get(webContentsId);
      const entry = history?.find(startTime);
      if (entry === undefined) return SKIPPED;
      return { execution_context: { id: entry.id, type: entry.type } };
    });

    collection.initRendererTracking();
    return collection;
  }

  private readonly onWebContentsCreated = monitor((_event: Electron.Event, webContents: Electron.WebContents) => {
    this.registerWebContents(webContents);
  });

  /**
   * Registers a fresh execution context for a webContents — called once at 'web-contents-created'
   * for a genuinely new one, and again after a crash/reload cycle: when a renderer crashes and the
   * app reloads the SAME WebContents object, Electron spawns a new OS process for it without ever
   * re-firing 'web-contents-created' (that event is tied to the WebContents object, not the process
   * living behind it). 'did-start-navigation' on that reload is the signal used here to detect the
   * replacement renderer and give it its own fresh execution context — as early as possible, before
   * any of the reloaded page's own scripts (and whatever RUM activity they generate) can run, rather
   * than leaving that webContents untagged for the whole reload.
   */
  private registerWebContents(webContents: Electron.WebContents): void {
    const webContentsId = webContents.id;
    const id = generateUUID();
    const startTime = timeStampNow();

    const previousListeners = this.attachedListeners.get(webContentsId);
    if (previousListeners) {
      webContents.removeListener('destroyed', previousListeners.destroyed);
      webContents.removeListener('render-process-gone', previousListeners.processGone);
    }
    this.pendingRevivals.delete(webContentsId);

    // Close whatever the previous cycle (a crash+reload revival on this same webContentsId) left
    // active, before registering this one — a no-op the first time this id is ever seen.
    const history = this.getOrCreateHistory(webContentsId);
    history.closeActive(startTime);
    history.add({ id, type: 'renderer-process' }, startTime);

    const state: RendererProcessState = {
      id,
      type: 'renderer-process',
      startTime,
      documentVersion: 1,
      // webContentsId rather than a process id (getProcessId()/getOSProcessId()): execution_context
      // is really about which webContents an event came from, not which OS process — and a process
      // id can't cleanly answer that anyway, since Electron can place multiple webContents in one
      // shared renderer process, and a real page navigation can move the same webContents to a
      // provisional, then a different final, process id before it settles. webContentsId has none
      // of that: it's assigned once, is always available synchronously, and never changes for this
      // webContents' lifetime — including across the crash+reload revival below. The schema's own
      // instance_id doc comment allows exactly this ("e.g. OS PID, thread ID, tab ID").
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
      const current = this.rendererStates.get(webContentsId);
      if (!current) {
        return;
      }
      clearInterval(current.timerId);
      this.rendererStates.delete(webContentsId);
      // Idempotent no-op if a preceding SESSION_EXPIRED already closed it — but a genuine
      // clean-exit/crash must always close it, or the entry stays "active" forever and a later,
      // unrelated webContentsId reuse (or a stray late event) would wrongly resolve to it.
      this.rendererHistories.get(webContentsId)?.closeActive(timeStampNow());
      if (current.closedForSessionExpiry) {
        // Already emitted this context's terminal update at the session boundary — a destroy
        // arriving during the sessionless gap must stop tagging but not mutate that already-closed
        // record with a bumped document_version/duration/exit_reason.
        return;
      }
      current.documentVersion++;
      this.emitExecutionContextEvent(current, exitReason);
    };

    const destroyed = monitor(() => {
      this.attachedListeners.delete(webContentsId);
      const pendingRevival = this.pendingRevivals.get(webContentsId);
      if (pendingRevival) {
        webContents.removeListener('did-start-navigation', pendingRevival);
        this.pendingRevivals.delete(webContentsId);
      }
      endRenderer('clean-exit');
    });
    const processGone = monitor((_e: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      endRenderer(details.reason);
      // Await the reload the app may perform on this same webContents (Electron reuses the object
      // across a crash, spawning a new process for it) — re-register on the reload's own navigation
      // start rather than its completion, so the replacement renderer is tagged before any of the
      // reloaded page's scripts run, not just once it finishes loading. If the app closes the window
      // instead, this listener simply never fires and is garbage collected along with the webContents.
      const previousRevival = this.pendingRevivals.get(webContentsId);
      if (previousRevival) {
        // The replacement renderer crashed again before its own navigation ever started — drop the
        // stale pending callback so it doesn't also fire once a navigation eventually starts, which
        // would register this webContents twice and orphan the earlier call's timer.
        webContents.removeListener('did-start-navigation', previousRevival);
      }
      const onRevival = monitor((details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
        // A crashed page can only be revived by navigating its main frame — ignore a subframe
        // navigation and keep waiting for that one.
        if (!details.isMainFrame) {
          return;
        }
        webContents.removeListener('did-start-navigation', onRevival);
        this.pendingRevivals.delete(webContentsId);
        this.registerWebContents(webContents);
      });
      webContents.on('did-start-navigation', onRevival);
      this.pendingRevivals.set(webContentsId, onRevival);
    });
    webContents.on('destroyed', destroyed);
    webContents.on('render-process-gone', processGone);
    this.attachedListeners.set(webContentsId, { webContents, destroyed, processGone });
  }

  stop(): void {
    app.removeListener('web-contents-created', this.onWebContentsCreated);
    for (const state of this.rendererStates.values()) {
      clearInterval(state.timerId);
    }
    this.rendererStates.clear();
    for (const { webContents, destroyed, processGone } of this.attachedListeners.values()) {
      webContents.removeListener('destroyed', destroyed);
      webContents.removeListener('render-process-gone', processGone);
    }
    for (const [webContentsId, pendingRevival] of this.pendingRevivals) {
      this.attachedListeners.get(webContentsId)?.webContents.removeListener('did-start-navigation', pendingRevival);
    }
    this.attachedListeners.clear();
    this.pendingRevivals.clear();
    this.rendererHistories.clear();
    this.lifecycleSubscription.unsubscribe();
  }

  private getOrCreateHistory(webContentsId: number): TimeStampValueHistory<RendererHistoryEntry> {
    let history = this.rendererHistories.get(webContentsId);
    if (!history) {
      history = new TimeStampValueHistory<RendererHistoryEntry>({ expireDelay: SESSION_TIME_OUT_DELAY });
      this.rendererHistories.set(webContentsId, history);
    }
    return history;
  }

  private initRendererTracking(): void {
    // Backfill webContents that already exist at this point — e.g. init() called after a window
    // opened, a supported deferred-init flow (see README's "Deferred init caveat"). Only future ones
    // would otherwise be seen: 'web-contents-created' fires once, at creation, so anything created
    // before this listener is attached would never get an execution context.
    for (const existing of webContentsModule.getAllWebContents()) {
      this.registerWebContents(existing);
    }

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
    const endTime = timeStampNow();
    for (const [webContentsId, state] of this.rendererStates) {
      clearInterval(state.timerId);
      state.documentVersion++;
      state.closedForSessionExpiry = true;
      this.rendererHistories.get(webContentsId)?.closeActive(endTime);
      this.emitExecutionContextEvent(state);
    }
  }

  private reopenAllRenderersForSessionRenewal(): void {
    for (const [webContentsId, previousState] of this.rendererStates) {
      const id = generateUUID();
      const startTime = timeStampNow();

      // A state registered during the sessionless gap (after SESSION_EXPIRED, before this renewal)
      // never went through closeAllRenderersForSessionExpiry, so its heartbeat is still ticking —
      // clear it before replacing the state, or it orphans: nothing keeps a reference to it once
      // this map entry is overwritten below, so it would otherwise tick forever, emitting a
      // duplicate heartbeat every interval alongside the new one.
      clearInterval(previousState.timerId);

      const history = this.getOrCreateHistory(webContentsId);
      history.closeActive(startTime);
      history.add({ id, type: 'renderer-process' }, startTime);

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
        startTime,
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
