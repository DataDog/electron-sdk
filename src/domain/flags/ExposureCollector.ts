import { createExposureEvent, getMD5Hash } from '@datadog/flagging-core';
import { EventKind, EventSource, EventTrack, type ServerEvent } from '../../event';
import type { FlagsState } from './FlagsState';
import type { EvaluationRecord } from '../../common/flags/types';
import type { FlagsExposureEvent } from './exposureEvent.types';

export const EXPOSURE_LRU_SIZE = 1000;

export interface ExposureCollectorConfiguration {
  service?: string;
  applicationId: string;
}

/**
 * Collects exposure events from main-process and renderer evaluations, deduplicating
 * them across processes (D8). Main is the single dedupe authority: every record
 * carries the `contextRevision` it was evaluated with, so a late renderer record
 * matches the exposure already emitted for that context instead of duplicating it.
 * The dedupe key is the hash of the subject (id and attributes), flag, allocation,
 * variant and configuration id — the same fields as the upstream exposure cache — and
 * is not cleared on context changes, so a record from an older context revision
 * never re-emits an exposure that was already sent.
 */
export class ExposureCollector {
  /** LRU of dedupe keys, least recently used first (a hit moves its key to the end). */
  private readonly emittedExposures = new Set<string>();

  constructor(
    private readonly state: FlagsState,
    private readonly configuration: ExposureCollectorConfiguration,
    private readonly onExposure: (event: ServerEvent) => void
  ) {}

  /**
   * Process an evaluation record. Emits at most one exposure per
   * (subject, attributes, flag, allocation, variant, configuration id).
   */
  add(record: EvaluationRecord): void {
    if (
      record.errorCode !== undefined ||
      record.reason === 'ERROR' ||
      record.variant === undefined ||
      record.allocationKey === undefined ||
      !record.doLog
    ) {
      return;
    }
    const context = this.state.getContext(record.contextRevision);
    if (context === undefined) {
      // The context revision is no longer retained: a late record is expected, drop it.
      return;
    }
    const details = {
      flagKey: record.flagKey,
      variant: record.variant,
      value: undefined,
      flagMetadata: {
        allocationKey: record.allocationKey,
        doLog: record.doLog,
        ...(record.serialId !== undefined ? { __dd_split_serial_id: record.serialId } : {}),
      },
    } as never; /* EvaluationDetails: only the exposure-relevant fields are read */
    const exposure = createExposureEvent(context, details);
    if (exposure === undefined) {
      return;
    }
    const configurationIdentity = record.configurationId ?? this.state.getConfigurationIdentity(record.contextRevision);
    // The configuration identity is the rules `configurationId`, or the precomputed
    // `createdAt` retained for the record's context revision when the record carries
    // none (D29) — a new `createdAt` re-logs, matching the upstream exposure cache clear.
    const dedupeKey = exposureDedupeKey(exposure, configurationIdentity);
    if (this.emittedExposures.has(dedupeKey)) {
      // A hit refreshes the entry so frequently evaluated flags stay in the LRU.
      this.rememberExposure(dedupeKey);
      return;
    }
    this.rememberExposure(dedupeKey);
    this.onExposure({
      kind: EventKind.SERVER,
      track: EventTrack.EXPOSURES,
      source: EventSource.MAIN,
      data: {
        ...exposure,
        ...(this.configuration.service !== undefined ? { service: this.configuration.service } : {}),
        rum: {
          application: { id: this.configuration.applicationId },
          view: { url: record.viewUrl ?? 'electron://main-process' },
        },
        timestamp: record.timestamp,
      } satisfies FlagsExposureEvent,
    });
  }

  private rememberExposure(dedupeKey: string): void {
    this.emittedExposures.delete(dedupeKey);
    this.emittedExposures.add(dedupeKey);
    while (this.emittedExposures.size > EXPOSURE_LRU_SIZE) {
      const oldest = this.emittedExposures.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.emittedExposures.delete(oldest);
    }
  }

  /** Clear the dedupe state. */
  stop(): void {
    this.emittedExposures.clear();
  }
}

function exposureDedupeKey(
  exposure: NonNullable<ReturnType<typeof createExposureEvent>>,
  configurationId: string | undefined
): string {
  return getMD5Hash(
    JSON.stringify([
      exposure.subject.id,
      exposure.subject.attributes,
      exposure.flag.key,
      exposure.allocation.key,
      exposure.variant.key,
      configurationId ?? '',
    ])
  );
}
