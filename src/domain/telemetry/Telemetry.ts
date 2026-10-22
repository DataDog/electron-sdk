import { jsonStringify, performDraw, type Subscription } from '@datadog/browser-core';
// These are internal browser-core exports, not part of the public API
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TODO(RUM-14336) expose those APIs from browser-core
import { startMonitorErrorCollection, monitor, callMonitored } from '@datadog/browser-core/cjs/tools/monitor';
import type { Configuration } from '../../config';
import { EventKind, EventManager, SessionRenewEvent, LifecycleKind, EventFormat } from '../../event';
import {
  RawTelemetryConfigurationData,
  RawTelemetryData,
  RawTelemetryType,
  RawTelemetryUsageData,
} from './rawTelemetryData.types';
import { SessionBudget } from './sessionBudget';

export { monitor, callMonitored };

const noop = () => undefined;

let telemetryInstance: Telemetry | undefined;

class Telemetry {
  /**
   * Whether each telemetry type is collected, drawn once per process. `configuration` and `usage`
   * are gated by their own rate on top of `telemetrySampleRate`, mirroring the Browser SDK.
   */
  private readonly isEnabled: Record<RawTelemetryType, boolean>;
  /** Combined rate actually applied per type, reported so the data can be scaled back up. */
  private readonly effectiveSampleRate: Record<RawTelemetryType, number>;
  private readonly budget = new SessionBudget();
  private sessionRenewSubscription: Subscription | undefined;

  constructor(
    private readonly eventManager: EventManager,
    configuration: Configuration
  ) {
    const telemetryEnabled = performDraw(configuration.telemetrySampleRate);
    this.isEnabled = {
      log: telemetryEnabled,
      configuration: telemetryEnabled && performDraw(configuration.telemetryConfigurationSampleRate),
      usage: telemetryEnabled && performDraw(configuration.telemetryUsageSampleRate),
    };
    this.effectiveSampleRate = {
      log: configuration.telemetrySampleRate,
      configuration: (configuration.telemetrySampleRate * configuration.telemetryConfigurationSampleRate) / 100,
      usage: (configuration.telemetrySampleRate * configuration.telemetryUsageSampleRate) / 100,
    };

    startMonitorErrorCollection((error: unknown) => {
      this.addError(error);
    });

    this.sessionRenewSubscription = eventManager.registerHandler<SessionRenewEvent>({
      canHandle: (event): event is SessionRenewEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.SESSION_RENEW,
      handle: () => {
        this.budget.reset();
      },
    });
  }

  addError(error: unknown): void {
    const { message, stack, kind } = formatError(error);
    this.add({
      type: 'telemetry',
      telemetry: {
        type: 'log',
        status: 'error',
        message,
        error: stack || kind ? { stack, kind } : undefined,
      },
    });
  }

  /** Report the resolved SDK configuration. Sent at most once per process. */
  addConfiguration(configuration: RawTelemetryConfigurationData): void {
    this.add({
      type: 'telemetry',
      telemetry: { type: 'configuration', configuration },
    });
  }

  /** Report that a public API was used. Deduplicated, so each distinct usage is sent once per session. */
  addUsage(usage: RawTelemetryUsageData): void {
    this.add({
      type: 'telemetry',
      telemetry: { type: 'usage', usage },
    });
  }

  /**
   * Sample, apply the per-session budget (deduplication and rate limit), then emit for assembly.
   */
  private add(data: RawTelemetryData): void {
    const type = data.telemetry.type;
    if (!this.isEnabled[type] || !this.budget.accept(data)) {
      return;
    }

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.TELEMETRY,
      data: { ...data, effective_sample_rate: this.effectiveSampleRate[type] },
    });
  }

  stop(): void {
    // resetMonitor() was removed in browser-core v7 (stale .d.ts, missing from JS).
    // Detach the error callback so monitor errors are silently dropped after telemetry stops.
    startMonitorErrorCollection(noop);
    this.sessionRenewSubscription?.unsubscribe();
  }
}

export function startTelemetry(eventManager: EventManager, configuration: Configuration): void {
  telemetryInstance = new Telemetry(eventManager, configuration);
}

export function addError(error: unknown): void {
  telemetryInstance?.addError(error);
}

/** Report the resolved SDK configuration. Consumed by configuration telemetry. */
export function addConfiguration(configuration: RawTelemetryConfigurationData): void {
  telemetryInstance?.addConfiguration(configuration);
}

/** Report that a public API was used. Consumed by usage telemetry. */
export function addUsage(usage: RawTelemetryUsageData): void {
  telemetryInstance?.addUsage(usage);
}

export function stopTelemetry(): void {
  telemetryInstance?.stop();
  telemetryInstance = undefined;
}

function formatError(error: unknown): { message: string; stack?: string; kind?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, kind: error.name };
  }
  // `jsonStringify` rather than `JSON.stringify`: a thrown non-Error value is arbitrary customer
  // data and may be circular, and this runs inside the monitor error callback where a throw escapes.
  return { message: `Uncaught ${jsonStringify(error) ?? String(error)}` };
}
