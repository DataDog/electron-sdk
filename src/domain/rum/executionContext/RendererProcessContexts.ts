import { app, webContents as webContentsModule } from 'electron';
import { elapsed, ONE_SECOND, timeStampNow, toServerDuration, type TimeStamp } from '@datadog/js-core/time';
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
import { monitor, setInterval, clearInterval, setTimeout, clearTimeout } from '../../telemetry';
import { SESSION_TIME_OUT_DELAY } from '../../session';
import { isActive, TimeStampValueHistory } from '../../../tools/TimeStampValueHistory';
import type { RawRumExecutionContext } from '../types';
import { PROCESS_UPDATE_INTERVAL } from './executionContext.constants';
import type { TrackingConsent, TrackingConsentChange, TrackingConsentManager } from '../../tracking-consent';

type ExecutionContextExitReason = RawRumExecutionContext['execution_context']['exit_reason'];

// Only needs to cover Electron's IPC queue latency, not upload-batch delay.
export const RENDERER_DISPOSAL_GRACE_PERIOD = 30 * ONE_SECOND;

/**
 * Tracks renderer-process lifecycle by owning one WebContentManager per webContentsId — created at
 * 'web-contents-created' (plus a backfill at start for any webContents already existing, e.g. a
 * deferred init() called after a window opened; only future ones would otherwise be seen, since
 * 'web-contents-created' fires once, at creation, and never again for a given webContents — not
 * even across a crash+reload, which is why WebContentManager needs its own signal to detect a
 * revival) and disposed a tolerance window after a manager reports its webContents is really gone
 * (see WebContentManager's onDisposed). Registers its own format hook that tags renderer-sourced RUM
 * events by resolving the matching manager's state at the event's own startTime — not just current
 * state — so an event delivered after a rotation but timestamped before it still resolves to the
 * context that was actually active then. Main-process tagging is MainProcessContext's own, separate
 * hook. Composed alongside MainProcessContext by ExecutionContextCollection, which owns neither's
 * internals.
 */
export class RendererProcessContexts {
  private readonly webContentManagers = new Map<number, WebContentManager>();
  private lifecycleSubscription!: Subscription;
  private consentSubscription!: Subscription;

  private constructor(
    private readonly eventManager: EventManager,
    private readonly consentManager: TrackingConsentManager
  ) {}

  static start(
    eventManager: EventManager,
    hooks: FormatHooks,
    consentManager: TrackingConsentManager
  ): RendererProcessContexts {
    const rendererProcessContexts = new RendererProcessContexts(eventManager, consentManager);

    hooks.registerRum(({ source, webContentsId, startTime }) => {
      if (source !== EventSource.RENDERER) return SKIPPED;
      const state = rendererProcessContexts.getState(webContentsId, startTime);
      if (state === undefined) return SKIPPED;
      return { execution_context: { id: state.executionContextId, type: state.type } };
    });

    rendererProcessContexts.initRendererTracking();
    return rendererProcessContexts;
  }

  /** The execution context active for a given webContentsId at a given time, if any is tracked. */
  private getState(webContentsId: number | undefined, startTime: TimeStamp): WebContentState | undefined {
    if (webContentsId === undefined) {
      return undefined;
    }
    return this.webContentManagers.get(webContentsId)?.getState(startTime);
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
          this.closeAllRenderersForSessionExpiry(event.time);
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          this.reopenAllRenderersForSessionRenewal(event.time);
        }
      },
    });
    this.consentSubscription = this.consentManager.subscribe((change) => {
      for (const manager of this.webContentManagers.values()) manager.updateConsent(change);
    });
  }

  private readonly onWebContentsCreated = monitor((_event: Electron.Event, webContents: Electron.WebContents) => {
    this.registerWebContents(webContents);
  });

  private registerWebContents(webContents: Electron.WebContents): void {
    const webContentsId = webContents.id;
    let manager = this.webContentManagers.get(webContentsId);
    if (!manager) {
      const newManager: WebContentManager = new WebContentManager(
        webContentsId,
        this.consentManager,
        (state, exitReason, atTime) => this.emitExecutionContextEvent(state, exitReason, atTime),
        () => {
          // Guard by identity, not just presence: webContentsId is never reused within a process's
          // lifetime, but this keeps disposal safe by construction rather than by that invariant.
          if (this.webContentManagers.get(webContentsId) === newManager) {
            this.webContentManagers.delete(webContentsId);
          }
        }
      );
      manager = newManager;
      this.webContentManagers.set(webContentsId, manager);
    }
    manager.register(webContents);
  }

  private emitExecutionContextEvent(
    state: WebContentState,
    exitReason?: ExecutionContextExitReason,
    atTime = timeStampNow()
  ): void {
    const data: RawRumExecutionContext = {
      type: 'execution_context',
      date: state.startTime,
      execution_context: {
        id: state.executionContextId,
        type: state.type,
        instance_id: state.instanceId,
        parent_instance_id: state.parentInstanceId,
        duration: toServerDuration(elapsed(state.startTime, atTime)),
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

  stop(): void {
    app.removeListener('web-contents-created', this.onWebContentsCreated);
    for (const manager of this.webContentManagers.values()) {
      manager.stop();
    }
    this.webContentManagers.clear();
    this.lifecycleSubscription.unsubscribe();
    this.consentSubscription.unsubscribe();
  }

  private closeAllRenderersForSessionExpiry(atTime?: TimeStamp): void {
    for (const manager of this.webContentManagers.values()) {
      manager.closeForSessionExpiry(atTime);
    }
  }

  private reopenAllRenderersForSessionRenewal(atTime?: TimeStamp): void {
    for (const manager of this.webContentManagers.values()) {
      manager.reopenForSessionRenewal(atTime);
    }
  }
}

interface WebContentState {
  executionContextId: string;
  type: 'renderer-process';
  startTime: TimeStamp;
  documentVersion: number;
  instanceId: string;
  parentInstanceId?: string;
  timerId: ReturnType<typeof setInterval>;
  consent: TrackingConsent;
  // Session and consent boundaries permit reuse of the window; a crash or destruction does not.
  // A later crash overwrites a temporary closure so session renewal cannot revive a dead renderer.
  closeReason?: 'session-expiry' | 'consent' | 'ended';
}

/**
 * Owns everything for one webContentsId — one execution context per webContents, (re)created via
 * register() (both for a genuinely new webContents and for a crash+reload revival of the same
 * one), rotated on SESSION_EXPIRED/SESSION_RENEW, and ended on a real 'destroyed' or
 * 'render-process-gone' with no revival.
 */
class WebContentManager {
  // Undefined before the first register(), and again after a real 'destroyed' — see onDestroyed,
  // which drops the reference immediately rather than holding the (now dead) WebContents object,
  // its listeners, and everything they close over alive for the whole retention window.
  private webContents?: Electron.WebContents;
  private readonly history = new TimeStampValueHistory<WebContentState>({ expireDelay: SESSION_TIME_OUT_DELAY });
  // Set while awaiting the reload a crashed webContents' owning app may perform on it.
  private pendingRevival?: (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => void;
  // Set while awaiting disposal after a real 'destroyed' — see onDestroyed.
  private disposalTimerId?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly webContentsId: number,
    private readonly consentManager: TrackingConsentManager,
    // Called by this manager every time it produces a state worth emitting: on register(),
    // closeForSessionExpiry(), reopenForSessionRenewal(), a crash/destroy exit, and the heartbeat.
    private readonly emit: (
      state: WebContentState,
      exitReason?: ExecutionContextExitReason,
      atTime?: TimeStamp
    ) => void,
    // Called once this manager will never be used again — a real 'destroyed' with no revival.
    private readonly onDisposed: () => void
  ) {}

  /**
   * Registers a fresh execution context — called once for a genuinely new webContents, and again
   * after a crash/reload cycle (see onProcessGone below). 'destroyed'/'render-process-gone' are
   * attached only once, at the very first registration: Electron reuses the same WebContents object
   * across a crash, so those listeners stay valid for this manager's entire lifetime and never need
   * removing/reattaching on a later revival.
   */
  register(webContents: Electron.WebContents, startTime = timeStampNow()): void {
    const isFirstRegistration = !this.webContents;
    this.webContents = webContents;
    if (isFirstRegistration) {
      webContents.on('destroyed', this.onDestroyed);
      webContents.on('render-process-gone', this.onProcessGone);
    }
    const consent = this.consentManager.get();
    if (consent === 'not-granted') return;

    const previousActive = this.history.getEntries()[0];
    if (previousActive && isActive(previousActive)) {
      // A prior state left ticking — e.g. a state registered during the sessionless gap, never
      // closed by closeForSessionExpiry, now being rotated by SESSION_RENEW. Left running, its
      // heartbeat would keep firing forever: nothing keeps a reference to it once the new entry
      // below replaces it as the active one.
      clearInterval(previousActive.value.timerId);
    }
    this.history.closeActive(startTime);

    const state: WebContentState = {
      executionContextId: generateUUID(),
      type: 'renderer-process',
      startTime,
      documentVersion: 1,
      consent,
      // webContentsId rather than a process id (getProcessId()/getOSProcessId()): execution_context
      // is really about which webContents an event came from, not which OS process — and a process
      // id can't cleanly answer that anyway, since Electron can place multiple webContents in one
      // shared renderer process, and a real page navigation can move the same webContents to a
      // provisional, then a different final, process id before it settles. webContentsId has none
      // of that: it's assigned once, is always available synchronously, and never changes for this
      // webContents' lifetime — including across the crash+reload revival above. The schema's own
      // instance_id doc comment allows exactly this ("e.g. OS PID, thread ID, tab ID").
      instanceId: String(this.webContentsId),
      parentInstanceId: String(process.pid),
      timerId: setInterval(() => {
        const current = this.getState();
        if (!current) {
          return;
        }
        current.documentVersion++;
        this.emit(current);
      }, PROCESS_UPDATE_INTERVAL),
    };
    this.history.add(state, startTime);

    this.emit(state, undefined, startTime);
  }

  /** Splits cumulative contexts at consent boundaries without reviving crashed or destroyed windows. */
  updateConsent(change: TrackingConsentChange): void {
    const current = this.getState();
    if (current?.consent === change.current) return;
    this.closePeriod('consent', change.time);
    if (change.current !== 'not-granted' && this.webContents && !this.pendingRevival) {
      this.register(this.webContents, change.time);
    }
  }

  private readonly onProcessGone = monitor((_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
    this.endRenderer(details.reason);
    // A crash always arrives on a still-live webContents, ahead of 'destroyed' ever dropping the
    // reference below — safe to assert.
    const webContents = this.webContents!;
    // Await the reload the app may perform on this same webContents (Electron reuses the object
    // across a crash, spawning a new process for it) — re-register on the reload's own navigation
    // start rather than its completion, so the replacement renderer is tagged before any of the
    // reloaded page's scripts run, not just once it finishes loading. If the app closes the window
    // instead, 'destroyed' fires and this manager is disposed instead.
    if (this.pendingRevival) {
      // The replacement renderer crashed again before its own navigation ever started — drop the
      // stale pending callback so it doesn't also fire once a navigation eventually starts, which
      // would register this webContents twice and orphan the earlier call's timer.
      webContents.removeListener('did-start-navigation', this.pendingRevival);
    }
    const onRevival = monitor((navDetails: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      // A crashed page can only be revived by navigating its main frame — ignore a subframe
      // navigation and keep waiting for that one.
      if (!navDetails.isMainFrame) {
        return;
      }
      webContents.removeListener('did-start-navigation', onRevival);
      this.pendingRevival = undefined;
      this.register(webContents);
    });
    webContents.on('did-start-navigation', onRevival);
    this.pendingRevival = onRevival;
  });

  private readonly onDestroyed = monitor(() => {
    // A real destroy always arrives on a still-live webContents.
    const webContents = this.webContents!;
    if (this.pendingRevival) {
      webContents.removeListener('did-start-navigation', this.pendingRevival);
      this.pendingRevival = undefined;
    }
    this.endRenderer('clean-exit');
    // Drop the (now dead) webContents and its listeners right away, not at disposal.
    webContents.removeListener('destroyed', this.onDestroyed);
    webContents.removeListener('render-process-gone', this.onProcessGone);
    this.webContents = undefined;
    // Disposal itself is deferred: a final IPC message can still be queued past 'destroyed'.
    this.disposalTimerId = setTimeout(() => this.onDisposed(), RENDERER_DISPOSAL_GRACE_PERIOD);
  });

  /** Resolves by the event's own startTime if given, otherwise the live state (undefined if none). */
  getState(startTime?: TimeStamp): WebContentState | undefined {
    if (startTime !== undefined) {
      return this.history.find(startTime);
    }
    const latest = this.history.getEntries()[0];
    return latest && isActive(latest) ? latest.value : undefined;
  }

  /**
   * A real crash/destroy exit — safe to call even if this webContents is already closed, whether
   * by a prior SESSION_EXPIRED or a prior call to this same method (e.g. 'render-process-gone'
   * followed by 'destroyed' with no revival in between). Emits the closed state itself, unless it
   * was already closed by SESSION_EXPIRED — that terminal update was already emitted, so only the
   * close reason is overwritten to 'ended', marking this context as truly gone rather than merely
   * between sessions (see reopenForSessionRenewal).
   */
  endRenderer(exitReason: ExecutionContextExitReason): void {
    const latest = this.history.getEntries()[0];
    if (!latest) {
      return;
    }
    const current = latest.value;
    if (!isActive(latest)) {
      current.closeReason = 'ended';
      return;
    }
    clearInterval(current.timerId);
    this.history.closeActive(timeStampNow());
    current.documentVersion++;
    current.closeReason = 'ended';
    this.emit(current, exitReason);
  }

  /** SESSION_EXPIRED. A no-op, mid-crash and awaiting either a revival or a real destroy. */
  closeForSessionExpiry(atTime = timeStampNow()): void {
    this.closePeriod('session-expiry', atTime);
  }

  private closePeriod(reason: 'session-expiry' | 'consent', atTime: TimeStamp): void {
    const current = this.getState();
    if (!current) {
      return;
    }
    clearInterval(current.timerId);
    current.documentVersion++;
    current.closeReason = reason;
    this.history.closeActive(atTime);
    this.emit(current, undefined, atTime);
  }

  /**
   * SESSION_RENEW. A no-op for a manager mid-crash, awaiting either a revival or a real destroy —
   * that one must be left untouched. register() itself clears the prior state's heartbeat if it
   * was still active (a gap-created state that never went through closeForSessionExpiry).
   */
  reopenForSessionRenewal(atTime = timeStampNow()): void {
    if (this.consentManager.get() === 'not-granted' || !this.webContents || this.pendingRevival) return;
    const latest = this.history.getEntries()[0];
    if (!latest) {
      return;
    }
    if (!isActive(latest) && latest.value.closeReason === 'ended') {
      return;
    }
    this.register(this.webContents, atTime);
  }

  stop(): void {
    const current = this.getState();
    if (current) {
      clearInterval(current.timerId);
    }
    clearTimeout(this.disposalTimerId);
    if (this.webContents) {
      this.webContents.removeListener('destroyed', this.onDestroyed);
      this.webContents.removeListener('render-process-gone', this.onProcessGone);
      if (this.pendingRevival) {
        this.webContents.removeListener('did-start-navigation', this.pendingRevival);
      }
    }
  }
}
