import { FlagEvaluationAggregator } from '@datadog/flagging-core';
import { ErrorCode } from '@openfeature/web-sdk';
import { EventKind, EventSource, EventTrack, type EventManager } from '../../event';
import type { EvaluationRecord } from '../../common/flags/types';
import { setInterval as sdkSetInterval, clearInterval as sdkClearInterval, monitor } from '../telemetry';
import type { FlagsState } from './FlagsState';

export const EVALUATION_AGGREGATION_INTERVAL = 10_000;
export const MAIN_PROCESS_VIEW_URL = 'electron://main-process';
/** Bound on distinct view urls aggregated between two flushes (each gets its own bucket). */
const MAX_VIEW_BUCKETS = 100;

type FlagEvaluationEvent = Parameters<ConstructorParameters<typeof FlagEvaluationAggregator>[1]>[0][number];

export interface EvaluationAggregatorConfiguration {
  service?: string;
  applicationId: string;
}

/**
 * Aggregates flag evaluation counts and sends them on the `flagevaluation` track (D9/M5),
 * emitting the upstream `FlagEvaluationEvent` contract exactly: the record's flag,
 * variant and allocation keys, its originating timestamp, and the
 * `context.dd.{service, rum.application.id, rum.view.url}` enrichment the Browser SDK
 * adds. The upstream contract has no fields for the split serial id, the configuration
 * id or `doLog`, so they are not sent.
 *
 * Fed upstream of the exposure dedupe: every evaluation counts, so two reads of one flag
 * count 2. Records are bucketed per view url (main records use
 * {@link MAIN_PROCESS_VIEW_URL}) so main and renderer evaluations keep their own view
 * attribution. One SDK-owned, monitored timer flushes every
 * {@link EVALUATION_AGGREGATION_INTERVAL}; the upstream aggregator's own interval is never
 * started.
 */
export class EvaluationAggregator {
  private readonly buckets = new Map<string, FlagEvaluationAggregator>();
  private intervalId: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly state: FlagsState,
    private readonly configuration: EvaluationAggregatorConfiguration,
    private readonly onAggregated: (events: FlagEvaluationEvent[]) => void
  ) {}

  /** Start the flush timer. */
  start(): void {
    this.intervalId = sdkSetInterval(
      monitor(() => this.flush()),
      EVALUATION_AGGREGATION_INTERVAL
    );
  }

  /** Count an evaluation, resolved against the context its `contextRevision` used. */
  add(record: EvaluationRecord): void {
    const context = this.state.getContext(record.contextRevision);
    if (context === undefined) {
      return;
    }
    const viewUrl = record.viewUrl ?? MAIN_PROCESS_VIEW_URL;
    let bucket = this.buckets.get(viewUrl);
    if (bucket === undefined) {
      if (this.buckets.size >= MAX_VIEW_BUCKETS) {
        this.flush();
      }
      bucket = new FlagEvaluationAggregator(EVALUATION_AGGREGATION_INTERVAL, (events) => {
        this.onAggregated(events.map((event) => this.enrich(event, viewUrl)));
      });
      this.buckets.set(viewUrl, bucket);
    }
    bucket.addEvaluation(
      context,
      {
        flagKey: record.flagKey,
        value: undefined,
        variant: record.variant,
        flagMetadata: {
          ...(record.allocationKey !== undefined ? { allocationKey: record.allocationKey } : {}),
          // The upstream aggregator reads the evaluation time from this key.
          __dd_eval_timestamp_ms: record.timestamp,
        },
      } as never,
      normalizeErrorCode(record.errorCode)
    );
  }

  /** Emit every aggregated event and reset the buckets. */
  flush(): void {
    const buckets = [...this.buckets.values()];
    this.buckets.clear();
    for (const bucket of buckets) {
      bucket.flush();
    }
  }

  /** Stop the timer and flush pending events. */
  stop(): void {
    if (this.intervalId !== undefined) {
      sdkClearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.flush();
  }

  private enrich(event: FlagEvaluationEvent, viewUrl: string): FlagEvaluationEvent {
    return {
      ...event,
      context: {
        ...event.context,
        dd: {
          ...(this.configuration.service !== undefined ? { service: this.configuration.service } : {}),
          rum: { application: { id: this.configuration.applicationId }, view: { url: viewUrl } },
        },
      },
    };
  }
}

/** Restrict error codes to the standard OpenFeature set, like the upstream hook. */
function normalizeErrorCode(errorCode: string | undefined): string | undefined {
  if (errorCode === undefined) {
    return undefined;
  }
  return (Object.values(ErrorCode) as string[]).includes(errorCode) ? errorCode : ErrorCode.GENERAL;
}

/**
 * Start the evaluation aggregator and wire it to the event manager on the
 * `flagevaluation` track. Returns undefined when the feature is disabled.
 */
export function startEvaluationAggregator(
  state: FlagsState,
  configuration: EvaluationAggregatorConfiguration & { enableFlagEvaluationTracking: boolean },
  eventManager: EventManager
): EvaluationAggregator | undefined {
  if (!configuration.enableFlagEvaluationTracking) {
    return undefined;
  }
  const aggregator = new EvaluationAggregator(state, configuration, (events) => {
    for (const event of events) {
      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.FLAGEVALUATION,
        source: EventSource.MAIN,
        data: event as unknown as Record<string, unknown>,
      });
    }
  });
  aggregator.start();
  return aggregator;
}
