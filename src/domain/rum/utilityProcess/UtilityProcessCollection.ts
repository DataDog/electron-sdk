import { app, utilityProcess, type UtilityProcess } from 'electron';
import {
  elapsed,
  generateUUID,
  ONE_SECOND,
  type TimeStamp,
  timeStampNow,
  toServerDuration,
} from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../../event';
import type { RawRumAction, RawRumError, RawRumView } from '../rawRumData.types';

export const METRICS_POLL_INTERVAL = 2 * ONE_SECOND;

interface ProcessView {
  viewId: string;
  startTime: TimeStamp;
  documentVersion: number;
  isActive: boolean;
  counters: { action: { count: number }; error: { count: number }; resource: { count: number } };
  serviceName: string;
  pid?: number;
  memorySamples: number[];
}

/**
 * Track Electron utility processes as RUM views.
 *
 * - On utilityProcess.fork(): start a new view ("Utility: {serviceName}")
 * - On spawn: update view with pid, transfer a dedicated MessagePort for error forwarding
 * - On exit (code=0): end view + emit action (clean exit)
 * - On exit (code≠0): end view + emit error (abnormal exit)
 * - On app 'child-process-gone': enrich error with crash details
 *
 * For error capture inside utility processes, the customer must import
 * '@datadog/electron-sdk/utility' at the top of their utility process entry file.
 * That module listens for the MessagePort transfer and registers error handlers.
 */
export class UtilityProcessCollection {
  private readonly processViews = new Map<UtilityProcess, ProcessView>();
  private readonly originalFork = utilityProcess.fork.bind(utilityProcess);
  private readonly childProcessGoneListener: (event: Electron.Event, details: Electron.Details) => void;
  private readonly metricsIntervalId: ReturnType<typeof setInterval>;

  constructor(private readonly eventManager: EventManager) {
    this.patchFork();

    this.childProcessGoneListener = (_event, details) => {
      this.onChildProcessGone(details);
    };
    app.on('child-process-gone', this.childProcessGoneListener);

    this.metricsIntervalId = setInterval(() => this.pollMetrics(), METRICS_POLL_INTERVAL);
  }

  stop(): void {
    Object.defineProperty(utilityProcess, 'fork', {
      value: this.originalFork,
      writable: true,
      configurable: true,
    });
    app.off('child-process-gone', this.childProcessGoneListener);
    clearInterval(this.metricsIntervalId);
    this.processViews.clear();
  }

  private patchFork(): void {
    const emitViewUpdate = this.emitViewUpdate.bind(this);
    const emitAction = this.emitAction.bind(this);
    const emitError = this.emitError.bind(this);
    const processViews = this.processViews;
    const originalFork = this.originalFork;

    Object.defineProperty(utilityProcess, 'fork', {
      value: function patchedFork(modulePath: string, args?: string[], options?: Electron.ForkOptions): UtilityProcess {
        const child = originalFork(modulePath, args, options);

        const serviceName = options?.serviceName ?? 'Node Utility Process';
        const view: ProcessView = {
          viewId: generateUUID(),
          startTime: timeStampNow(),
          documentVersion: 1,
          isActive: true,
          counters: { action: { count: 0 }, error: { count: 0 }, resource: { count: 0 } },
          serviceName,
          memorySamples: [],
        };
        processViews.set(child, view);

        // Emit initial view
        emitViewUpdate(view);

        // Intercept child.emit('message') to capture SDK-internal messages (__dd)
        // sent by the utility process via process.parentPort.postMessage().
        // This approach:
        // - Does NOT override child.on/child.once (which breaks Electron internals)
        // - Does NOT register parentPort.on('message') in the utility process (which drains the buffer)
        // - Does NOT transfer MessagePorts on spawn (which blocks all messages)
        // Instead, SDK messages are swallowed at emit time before reaching customer handlers.
        const originalEmit = child.emit.bind(child);
        child.emit = function (event: string, ...args: unknown[]): boolean {
          if (event === 'message') {
            const msg = args[0];
            if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).__dd) {
              const data = msg as { __dd: true; type?: string; message?: string; stack?: string };
              if (data.type === 'error' && data.message) {
                view.counters.error.count++;
                view.documentVersion++;
                emitError(view, data.message, { stack: data.stack });
                emitViewUpdate(view);
              }
              return true; // Swallow — don't propagate to customer handlers
            }
          }
          return originalEmit(event, ...args);
        } as typeof child.emit;

        child.once('spawn', () => {
          view.pid = child.pid ?? undefined;
          view.documentVersion++;
          emitViewUpdate(view);
        });

        child.once('exit', (code: number) => {
          view.isActive = false;
          view.documentVersion++;

          if (code === 0) {
            // Clean exit → action
            view.counters.action.count++;
            emitAction(view, 'process_exit');
          } else {
            // Abnormal exit → error
            view.counters.error.count++;
            emitError(view, `Utility process "${serviceName}" exited with code ${code}`, {
              exit_code: code,
            });
          }

          emitViewUpdate(view);

          // Keep in map briefly for child-process-gone enrichment, then clean up
          setTimeout(() => processViews.delete(child), 5000);
        });

        return child;
      },
      writable: true,
      configurable: true,
    });
  }

  private pollMetrics(): void {
    const metrics = app.getAppMetrics();
    for (const [, view] of this.processViews) {
      if (!view.isActive || view.pid === undefined) continue;

      const metric = metrics.find((m) => m.pid === view.pid);
      if (metric) {
        // workingSetSize is in KB, store as bytes
        view.memorySamples.push(metric.memory.workingSetSize * 1024);
        view.documentVersion++;
        this.emitViewUpdate(view);
      }
    }
  }

  private onChildProcessGone(details: Electron.Details): void {
    if (details.type !== 'Utility') return;

    // Find matching process view by serviceName
    for (const [, view] of this.processViews) {
      if (view.serviceName === details.serviceName && view.isActive) {
        view.isActive = false;
        view.documentVersion++;
        view.counters.error.count++;

        const isCrash = details.reason === 'crashed' || details.reason === 'oom';
        this.emitError(view, `Utility process "${view.serviceName}" gone: ${details.reason}`, {
          reason: details.reason,
          exit_code: details.exitCode,
          is_crash: isCrash,
        });

        this.emitViewUpdate(view);
        break;
      }
    }
  }

  private emitViewUpdate(view: ProcessView): void {
    const viewEvent: RawRumView = {
      type: 'view',
      date: view.startTime,
      view: {
        id: view.viewId,
        name: `Utility: ${view.serviceName}`,
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
      ...(view.pid !== undefined ? { context: { pid: view.pid } } : {}),
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: viewEvent,
      startTime: view.startTime,
    });
  }

  private emitAction(view: ProcessView, targetName: string): void {
    const actionEvent: RawRumAction = {
      type: 'action',
      date: timeStampNow(),
      view: { id: view.viewId, name: `Utility: ${view.serviceName}` },
      action: {
        id: generateUUID(),
        type: 'custom',
        target: { name: targetName },
      },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: actionEvent,
      startTime: view.startTime,
    });
  }

  private emitError(view: ProcessView, message: string, context: Record<string, unknown>): void {
    const errorEvent: RawRumError = {
      type: 'error',
      date: timeStampNow(),
      view: { id: view.viewId, name: `Utility: ${view.serviceName}` },
      context,
      error: {
        id: generateUUID(),
        message,
        stack: typeof context.stack === 'string' ? context.stack : undefined,
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
