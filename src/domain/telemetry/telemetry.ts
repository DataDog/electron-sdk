import { performDraw, type Subscription } from '@datadog/browser-core';
// These are internal browser-core exports, not part of the public API
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TODO(RUM-14336) expose those APIs from browser-core
import {
  startMonitorErrorCollection,
  resetMonitor,
  monitor,
  callMonitored,
} from '@datadog/browser-core/cjs/tools/monitor';
import type { Configuration } from '../../config';
import type { TelemetryErrorEvent } from './telemetryEvent.types';
import { EventKind, EventSource, EventManager, SessionRenewEvent, LifecycleKind } from '../../event';

export { monitor, callMonitored };

const MAX_TELEMETRY_EVENTS_PER_SESSION = 100;

let telemetryInstance: Telemetry | undefined;

class Telemetry {
  private readonly isEnabled: boolean;
  private eventCount = 0;
  private sessionRenewSubscription: Subscription | undefined;

  constructor(
    private readonly eventManager: EventManager,
    private readonly configuration: Configuration
  ) {
    this.isEnabled = performDraw(configuration.telemetrySampleRate);

    startMonitorErrorCollection((error: unknown) => {
      this.addError(error);
    });

    this.sessionRenewSubscription = eventManager.registerHandler<SessionRenewEvent>({
      canHandle: (event): event is SessionRenewEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.SESSION_RENEW,
      handle: () => {
        this.eventCount = 0;
      },
    });
  }

  addError(error: unknown): void {
    if (!this.isEnabled || this.eventCount >= MAX_TELEMETRY_EVENTS_PER_SESSION) {
      return;
    }
    this.eventCount++;
    const data = this.createErrorEvent(error);
    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      data,
    });
  }

  stop(): void {
    resetMonitor();
    this.sessionRenewSubscription?.unsubscribe();
  }

  private createErrorEvent(error: unknown): TelemetryErrorEvent {
    const { message, stack, kind } = formatError(error);
    return {
      _dd: { format_version: 2 },
      type: 'telemetry',
      date: Date.now(),
      service: 'electron-sdk',
      source: 'electron',
      version: '0.0.0', // TODO(RUM-14340) use sdk version
      application: { id: this.configuration.applicationId },
      telemetry: {
        type: 'log',
        status: 'error',
        message,
        error: stack || kind ? { stack, kind } : undefined,
      },
    };
  }
}

export function startTelemetry(eventManager: EventManager, configuration: Configuration): void {
  telemetryInstance = new Telemetry(eventManager, configuration);
}

export function addError(error: unknown): void {
  telemetryInstance?.addError(error);
}

export function stopTelemetry(): void {
  telemetryInstance?.stop();
  telemetryInstance = undefined;
}

function formatError(error: unknown): { message: string; stack?: string; kind?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, kind: error.name };
  }
  return { message: `Uncaught ${JSON.stringify(error)}` };
}
