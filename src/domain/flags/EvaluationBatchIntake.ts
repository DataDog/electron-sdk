import { addError as addTelemetryError, addDebug as addTelemetryDebug } from '../telemetry';
import { MAX_BATCH_BYTES, parseEvaluationBatch } from '../../common/flags/flagsPayloads';
import type { EvaluationRecord } from '../../common/flags/types';

/** Bound of one evaluation batch, in UTF-8 bytes of the complete serialized envelope (R4). */
export const MAX_BATCH_JSON_LENGTH = MAX_BATCH_BYTES;
export const DROPPED_RECORDS_DEBUG_INTERVAL = 10_000;
export const DROPPED_RECORDS_DEBUG_MESSAGE = 'flags: dropped evaluation records';

/** Where a batch came from; tags forwarded errors. */
export type BatchSource = 'renderer' | 'child';

const ERROR_NAMES: Record<BatchSource, string> = {
  renderer: 'RendererFlagsError',
  child: 'ChildFlagsError',
};

/**
 * Shared main-process intake of evaluation batches from renderers and spawned children.
 * Validates a JSON batch with partial acceptance (oversize or non-string payloads rejected
 * before parsing), forwards valid records with their source, and reports the batch's SDK
 * errors to telemetry (at most 5, message and stack bounded by the parser).
 *
 * Dropped records — malformed, oversize or non-string payloads, invalid records, records
 * beyond the per-batch cap, and malformed child context requests — are reported as SDK
 * debug telemetry with the count only, at most once per
 * {@link DROPPED_RECORDS_DEBUG_INTERVAL} per process (§3a); counts in between are
 * accumulated into the next report. One instance is shared by every source so the rate
 * limit is per process.
 */
export class EvaluationBatchIntake {
  private lastDebugAt: number | undefined;
  private pendingDroppedCount = 0;

  constructor(private readonly onRecord: (record: EvaluationRecord, source: BatchSource) => void) {}

  receive(json: unknown, source: BatchSource): void {
    const parsed = typeof json === 'string' ? parseEvaluationBatch(json, MAX_BATCH_JSON_LENGTH) : undefined;
    if (parsed === undefined) {
      this.reportDropped(1);
      return;
    }
    const { batch, droppedCount } = parsed;
    if (droppedCount > 0) {
      this.reportDropped(droppedCount);
    }
    for (const error of batch.errors ?? []) {
      addTelemetryError(toSourceError(error, ERROR_NAMES[source]));
    }
    for (const record of batch.records) {
      this.onRecord(record, source);
    }
  }

  /** Count dropped payloads; reported as a rate-limited, count-only debug log. */
  reportDropped(count: number): void {
    this.pendingDroppedCount += count;
    const now = Date.now();
    if (this.lastDebugAt !== undefined && now - this.lastDebugAt < DROPPED_RECORDS_DEBUG_INTERVAL) {
      return;
    }
    this.lastDebugAt = now;
    addTelemetryDebug(DROPPED_RECORDS_DEBUG_MESSAGE, { count: this.pendingDroppedCount });
    this.pendingDroppedCount = 0;
  }
}

/** Rebuild a process error with its bounded message and stack, tagged with its source. */
function toSourceError(error: { message: string; stack?: string }, name: string): Error {
  const sourceError = new Error(error.message);
  sourceError.name = name;
  sourceError.stack = error.stack ?? `${name}: ${error.message}`;
  return sourceError;
}
