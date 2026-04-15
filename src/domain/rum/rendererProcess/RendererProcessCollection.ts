import { app, webContents as webContentsModule, type WebContents } from 'electron';
import {
  elapsed,
  generateUUID,
  ONE_SECOND,
  type TimeStamp,
  timeStampNow,
  toServerDuration,
} from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../../event';
import type { RawRumError, RawRumView } from '../rawRumData.types';

export const METRICS_POLL_INTERVAL = 2 * ONE_SECOND;

interface RendererView {
  viewId: string;
  startTime: TimeStamp;
  documentVersion: number;
  isActive: boolean;
  counters: { action: { count: number }; error: { count: number }; resource: { count: number } };
  pid: number;
  title: string;
  memorySamples: number[];
}

/**
 * Track Electron renderer processes as RUM views.
 *
 * - Detect renderers immediately via app 'web-contents-created'
 * - Poll app.getAppMetrics() for memory metrics updates
 * - Handle render-process-gone → emit error on renderer view
 * - Expose getRendererViewId(pid) for Assembly container hierarchy
 */
export class RendererProcessCollection {
  private readonly rendererViews = new Map<number, RendererView>();
  /** Map webContents.id → OS pid, so we can look up the view after process death. */
  private readonly webContentsIdToPid = new Map<number, number>();
  private readonly metricsIntervalId: ReturnType<typeof setInterval>;
  private readonly webContentsCreatedListener: (event: Electron.Event, wc: WebContents) => void;
  private readonly renderProcessGoneListener: (
    event: Electron.Event,
    webContents: WebContents,
    details: Electron.RenderProcessGoneDetails
  ) => void;

  constructor(private readonly eventManager: EventManager) {
    this.webContentsCreatedListener = (_event, wc) => {
      this.onWebContentsCreated(wc);
    };
    app.on('web-contents-created', this.webContentsCreatedListener);

    this.renderProcessGoneListener = (_event, wc, details) => {
      this.onRenderProcessGone(wc, details);
    };
    app.on('render-process-gone', this.renderProcessGoneListener);

    // Detect renderers that were created before the SDK initialized
    for (const wc of webContentsModule.getAllWebContents()) {
      this.trackWebContents(wc);
    }

    // Poll only for metrics updates, not for detection
    this.metricsIntervalId = setInterval(() => this.pollMetrics(), METRICS_POLL_INTERVAL);
  }

  stop(): void {
    app.off('web-contents-created', this.webContentsCreatedListener);
    app.off('render-process-gone', this.renderProcessGoneListener);
    clearInterval(this.metricsIntervalId);
    this.rendererViews.clear();
  }

  /** Get the view ID for a renderer process by its OS pid. Used by Assembly for container hierarchy. */
  getRendererViewId(pid: number): string | undefined {
    return this.rendererViews.get(pid)?.viewId;
  }

  private onWebContentsCreated(wc: WebContents): void {
    // Try to track as early as possible — did-start-navigation fires before did-finish-load
    wc.once('did-start-navigation', () => {
      if (!this.trackWebContents(wc)) {
        // pid not available yet — fall back to did-finish-load
        wc.once('did-finish-load', () => {
          this.trackWebContents(wc);
        });
      }
    });

    // Page title is available only after the HTML is loaded — update the view name
    wc.once('page-title-updated', () => {
      this.trackWebContents(wc);
    });
  }

  /**
   * Try to create a view for the given webContents.
   * Returns true if the renderer was successfully tracked (or already tracked).
   */
  private trackWebContents(wc: WebContents): boolean {
    if (wc.isDestroyed()) return false;

    const pid = wc.getOSProcessId();
    if (pid === 0) return false;

    this.webContentsIdToPid.set(wc.id, pid);

    const existingView = this.rendererViews.get(pid);
    if (existingView) {
      // Update title if the view was lazily created with a fallback name
      const title = wc.getTitle();
      if (title && existingView.title !== title) {
        existingView.title = title;
        existingView.documentVersion++;
        this.emitViewUpdate(existingView);
      }
    } else {
      this.createRendererView(pid, wc.getTitle() || 'unknown');
    }
    return true;
  }

  /**
   * Get or create a renderer view for the given pid.
   * Called by Assembly to guarantee the view exists before the first bridge event.
   */
  getOrCreateRendererViewId(pid: number, eventDate?: number): string {
    let view = this.rendererViews.get(pid);
    if (!view) {
      view = this.createRendererView(pid, 'unknown', eventDate);
    } else if (eventDate && eventDate < view.startTime) {
      // Backdate if this event predates the current startTime
      view.startTime = eventDate as TimeStamp;
      view.documentVersion++;
      this.emitViewUpdate(view);
    }
    return view.viewId;
  }

  private createRendererView(pid: number, title: string, startDate?: number): RendererView {
    const view: RendererView = {
      viewId: generateUUID(),
      startTime: (startDate ?? timeStampNow()) as TimeStamp,
      documentVersion: 1,
      isActive: true,
      counters: { action: { count: 0 }, error: { count: 0 }, resource: { count: 0 } },
      pid,
      title,
      memorySamples: [],
    };
    this.rendererViews.set(pid, view);
    this.emitViewUpdate(view);
    return view;
  }

  private pollMetrics(): void {
    const metrics = app.getAppMetrics();
    const allWebContents = webContentsModule.getAllWebContents();
    const activePids = new Set<number>();

    for (const wc of allWebContents) {
      if (!wc.isDestroyed()) {
        const pid = wc.getOSProcessId();
        if (pid !== 0) activePids.add(pid);
      }
    }

    for (const [pid, view] of this.rendererViews) {
      if (!view.isActive) continue;

      // Mark views for pids that are no longer active
      if (!activePids.has(pid)) {
        view.isActive = false;
        view.documentVersion++;
        this.emitViewUpdate(view);
        continue;
      }

      // Update memory metrics
      const metric = metrics.find((m) => m.pid === pid);
      if (metric) {
        view.memorySamples.push(metric.memory.workingSetSize * 1024);
        view.documentVersion++;
        this.emitViewUpdate(view);
      }
    }
  }

  private onRenderProcessGone(wc: WebContents, details: Electron.RenderProcessGoneDetails): void {
    // After crash, getOSProcessId() may return 0 — use our saved mapping
    const pid = this.webContentsIdToPid.get(wc.id) ?? wc.getOSProcessId();
    const view = this.rendererViews.get(pid);
    if (!view) return;

    view.isActive = false;
    view.documentVersion++;
    view.counters.error.count++;

    const isCrash = details.reason === 'crashed' || details.reason === 'oom';
    this.emitError(view, `Renderer process (pid ${pid}) gone: ${details.reason}`, {
      reason: details.reason,
      exit_code: details.exitCode,
      is_crash: isCrash,
    });

    this.emitViewUpdate(view);
  }

  private emitViewUpdate(view: RendererView): void {
    const viewEvent: RawRumView = {
      type: 'view',
      date: view.startTime,
      view: {
        id: view.viewId,
        name: `Renderer: ${view.title}`,
        time_spent: toServerDuration(elapsed(view.startTime, timeStampNow())),
        is_active: view.isActive,
        ...view.counters,
        ...(view.memorySamples.length > 0
          ? {
              memory_average: Math.round(view.memorySamples.reduce((a, b) => a + b, 0) / view.memorySamples.length),
              memory_max: Math.max(...view.memorySamples),
            }
          : {}),
      },
      _dd: { document_version: view.documentVersion },
      context: { pid: view.pid },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: viewEvent,
      startTime: view.startTime,
    });
  }

  private emitError(view: RendererView, message: string, context: Record<string, unknown>): void {
    const errorEvent: RawRumError = {
      type: 'error',
      date: timeStampNow(),
      view: { id: view.viewId },
      context,
      error: {
        id: generateUUID(),
        message,
        source: 'source',
        handling: 'unhandled',
        is_crash: context.is_crash ? true : undefined,
      },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: errorEvent,
      startTime: view.startTime,
    });
  }
}
