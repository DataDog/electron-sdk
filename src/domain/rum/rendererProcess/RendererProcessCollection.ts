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

export const RENDERER_POLL_INTERVAL = 2 * ONE_SECOND;

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
 * - Detect renderers via webContents.getAllWebContents() + getOSProcessId()
 * - Create a view per renderer process
 * - Attach memory metrics from app.getAppMetrics()
 * - Handle render-process-gone → emit error on renderer view
 * - Expose getRendererViewId(pid) for Assembly container hierarchy
 */
export class RendererProcessCollection {
  private readonly rendererViews = new Map<number, RendererView>();
  /** Map webContents.id → OS pid, so we can look up the view after process death. */
  private readonly webContentsIdToPid = new Map<number, number>();
  private readonly pollIntervalId: ReturnType<typeof setInterval>;
  private readonly renderProcessGoneListener: (
    event: Electron.Event,
    webContents: WebContents,
    details: Electron.RenderProcessGoneDetails
  ) => void;

  constructor(private readonly eventManager: EventManager) {
    this.renderProcessGoneListener = (_event, wc, details) => {
      this.onRenderProcessGone(wc, details);
    };
    app.on('render-process-gone', this.renderProcessGoneListener);

    this.pollIntervalId = setInterval(() => this.pollRenderers(), RENDERER_POLL_INTERVAL);
  }

  stop(): void {
    app.off('render-process-gone', this.renderProcessGoneListener);
    clearInterval(this.pollIntervalId);
    this.rendererViews.clear();
  }

  /** Get the view ID for a renderer process by its OS pid. Used by Assembly for container hierarchy. */
  getRendererViewId(pid: number): string | undefined {
    return this.rendererViews.get(pid)?.viewId;
  }

  private pollRenderers(): void {
    const allWebContents = webContentsModule.getAllWebContents();
    const metrics = app.getAppMetrics();
    const activePids = new Set<number>();

    for (const wc of allWebContents) {
      if (wc.isDestroyed()) continue;

      const pid = wc.getOSProcessId();
      if (pid === 0) continue;
      activePids.add(pid);

      this.webContentsIdToPid.set(wc.id, pid);

      let view = this.rendererViews.get(pid);
      if (!view) {
        // New renderer detected
        const title = wc.getTitle() || `Renderer (pid ${pid})`;
        view = {
          viewId: generateUUID(),
          startTime: timeStampNow(),
          documentVersion: 1,
          isActive: true,
          counters: { action: { count: 0 }, error: { count: 0 }, resource: { count: 0 } },
          pid,
          title,
          memorySamples: [],
        };
        this.rendererViews.set(pid, view);
        this.emitViewUpdate(view);
      }

      // Update memory metrics
      const metric = metrics.find((m) => m.pid === pid);
      if (metric) {
        view.memorySamples.push(metric.memory.workingSetSize * 1024);
        view.documentVersion++;
        this.emitViewUpdate(view);
      }
    }

    // Mark views for pids that are no longer active
    for (const [pid, view] of this.rendererViews) {
      if (!activePids.has(pid) && view.isActive) {
        view.isActive = false;
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
      },
      _dd: { document_version: view.documentVersion },
      context: {
        pid: view.pid,
        ...(view.memorySamples.length > 0
          ? {
              memory_average: Math.round(view.memorySamples.reduce((a, b) => a + b, 0) / view.memorySamples.length),
              memory_max: Math.max(...view.memorySamples),
            }
          : {}),
      },
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
