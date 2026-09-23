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
import type { RawRumExecutionContext } from '../types';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';
import { deriveExecutionContextName } from './deriveExecutionContextName';

type ExecutionContextExitReason = RawRumExecutionContext['execution_context']['exit_reason'];

interface RendererProcessState {
  id: string;
  type: 'renderer-process';
  startTime: TimeStamp;
  documentVersion: number;
  instanceId: string;
  parentInstanceId?: string;
  timerId: ReturnType<typeof setInterval>;
  webContents: Electron.WebContents;
  // Derived from webContents.getURL() the first time it's non-empty (web-contents-created fires
  // before any navigation, so the URL is often empty at registration), then frozen for the rest
  // of this context's lifetime — a later navigation within the same context does not rename it.
  name?: string;
  // True only for a crash-revival registration: registerWebContents runs on 'did-start-navigation',
  // before the new navigation commits, so getURL() can still return the pre-crash page's URL. Blocks
  // the eager backfill in emitExecutionContextEvent from freezing that stale name — only 'dom-ready'
  // (which fires once the new navigation actually commits) may resolve the name for this state.
  pendingNavigation?: boolean;
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
 * reason). Registers its own format hook that tags renderer-sourced RUM events straight from its
 * own rendererStates map — main-process tagging is MainProcessContext's own, separate hook.
 * Composed alongside MainProcessContext by ExecutionContextCollection, which owns neither's
 * internals.
 */
interface AttachedListeners {
  webContents: Electron.WebContents;
  destroyed: () => void;
  processGone: (event: Electron.Event, details: Electron.RenderProcessGoneDetails) => void;
  domReady: () => void;
}

export class RendererProcessContexts {
  private readonly rendererStates = new Map<number, RendererProcessState>();
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

    hooks.registerRum(({ source, webContentsId }) => {
      if (source !== EventSource.RENDERER) return SKIPPED;
      const state = webContentsId === undefined ? undefined : collection.rendererStates.get(webContentsId);
      if (state === undefined) return SKIPPED;
      return { execution_context: { id: state.id, type: state.type, name: state.name } };
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

    const previousListeners = this.attachedListeners.get(webContentsId);
    if (previousListeners) {
      webContents.removeListener('destroyed', previousListeners.destroyed);
      webContents.removeListener('render-process-gone', previousListeners.processGone);
      webContents.removeListener('dom-ready', previousListeners.domReady);
    }
    this.pendingRevivals.delete(webContentsId);

    const state: RendererProcessState = {
      id,
      type: 'renderer-process',
      startTime: timeStampNow(),
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
      webContents,
      pendingNavigation: previousListeners !== undefined,
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
      if (current.closedForSessionExpiry) {
        // Already emitted this context's terminal update at the session boundary — a destroy
        // arriving during the sessionless gap must stop tagging but not mutate that already-closed
        // record with a bumped document_version/duration/exit_reason.
        return;
      }
      current.documentVersion++;
      this.emitExecutionContextEvent(current, exitReason);
    };

    // web-contents-created fires before the caller ever calls loadURL, so the initial emit above
    // almost always sees an empty getURL() — without this, the name would only resolve on the
    // next heartbeat, up to PROCESS_UPDATE_INTERVAL later. 'dom-ready' fires once the navigation
    // has committed and the URL is reliable, so recheck there instead of waiting on the timer.
    // Kept attached for this webContents' whole lifetime (harmless once name is frozen) rather
    // than removed after first use, matching how 'destroyed'/'render-process-gone' are handled.
    const domReady = monitor(() => {
      const current = this.rendererStates.get(webContentsId);
      // closedForSessionExpiry: this context's terminal update was already emitted at the session
      // boundary — the same invariant endRenderer protects against a real destroy mutating.
      if (!current || current.name !== undefined || current.closedForSessionExpiry || webContents.isDestroyed()) {
        return;
      }
      const derived = deriveExecutionContextName(webContents.getURL());
      if (derived === undefined) {
        return;
      }
      current.name = derived;
      // The revival this state was pending on has now committed — otherwise a later renewal with
      // no further navigation would carry this flag forward forever, permanently blocking the
      // backfill-on-emit check from ever resolving a name for it again.
      current.pendingNavigation = false;
      current.documentVersion++;
      this.emitExecutionContextEvent(current);
    });
    webContents.on('dom-ready', domReady);

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
    this.attachedListeners.set(webContentsId, { webContents, destroyed, processGone, domReady });
  }

  stop(): void {
    app.removeListener('web-contents-created', this.onWebContentsCreated);
    for (const state of this.rendererStates.values()) {
      clearInterval(state.timerId);
    }
    this.rendererStates.clear();
    for (const { webContents, destroyed, processGone, domReady } of this.attachedListeners.values()) {
      webContents.removeListener('destroyed', destroyed);
      webContents.removeListener('render-process-gone', processGone);
      webContents.removeListener('dom-ready', domReady);
    }
    for (const [webContentsId, pendingRevival] of this.pendingRevivals) {
      this.attachedListeners.get(webContentsId)?.webContents.removeListener('did-start-navigation', pendingRevival);
    }
    this.attachedListeners.clear();
    this.pendingRevivals.clear();
    this.lifecycleSubscription.unsubscribe();
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

      // A state registered during the sessionless gap (after SESSION_EXPIRED, before this renewal)
      // never went through closeAllRenderersForSessionExpiry, so its heartbeat is still ticking —
      // clear it before replacing the state, or it orphans: nothing keeps a reference to it once
      // this map entry is overwritten below, so it would otherwise tick forever, emitting a
      // duplicate heartbeat every interval alongside the new one.
      clearInterval(previousState.timerId);

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
        webContents: previousState.webContents,
        // Carried over so a crash-revived renderer still awaiting its own dom-ready doesn't have
        // this emit backfill its name from a still-stale getURL() just because it crossed a
        // session boundary first.
        pendingNavigation: previousState.pendingNavigation,
      };
      this.rendererStates.set(webContentsId, state);

      this.emitExecutionContextEvent(state);
    }
  }

  private emitExecutionContextEvent(state: RendererProcessState, exitReason?: ExecutionContextExitReason): void {
    if (state.name === undefined && !state.pendingNavigation && !state.webContents.isDestroyed()) {
      state.name = deriveExecutionContextName(state.webContents.getURL());
    }

    const data: RawRumExecutionContext = {
      type: 'execution_context',
      date: state.startTime,
      execution_context: {
        id: state.id,
        type: state.type,
        name: state.name,
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
