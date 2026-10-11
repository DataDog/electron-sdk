import {
  MAX_BATCH_BYTES,
  MAX_BATCH_ERRORS,
  MAX_BATCH_ERROR_MESSAGE_LENGTH,
  MAX_BATCH_RECORDS,
  utf8ByteLength,
} from './flagsPayloads';
import type { EvaluationRecord, FlagsTracking } from './types';

export const FLUSH_INTERVAL = 1_000;
export const FLUSH_THRESHOLD = 50;
// The limits are the intake's (A2): one definition for producers and the parser.
export const MAX_RECORDS_PER_BATCH = MAX_BATCH_RECORDS;
export { MAX_BATCH_BYTES };
export const MAX_ERRORS_PER_BATCH = MAX_BATCH_ERRORS;
const MAX_PREDEDUPE_KEYS = 1000;
/** `{"records":[]}` */
const EMPTY_ENVELOPE_BYTES = 14;

export interface EvaluationReporterDependencies {
  /** Deliver one JSON-encoded {@link EvaluationBatch} to main. */
  send: (json: string) => void;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /**
   * Whether RUM correlation for these records happens in main (spawned children, D19). A
   * renderer correlates locally through `DD_RUM`, so it leaves this off.
   */
  rumViaMain?: boolean;
}

/**
 * Buffers evaluation records and SDK errors from a non-main process (renderer or spawned
 * child) and delivers them to main in bounded batches (§3a, D15): a flush after
 * {@link FLUSH_INTERVAL} or {@link FLUSH_THRESHOLD} records, at most
 * {@link MAX_RECORDS_PER_BATCH} records and {@link MAX_BATCH_BYTES} of JSON per batch, at
 * most {@link MAX_ERRORS_PER_BATCH} errors truncated to 1024 chars. Records follow the
 * snapshot tracking toggles: nothing is sent only when every sink this reporter feeds is off
 * (exposures, metrics and, with `rumViaMain`, RUM); main routes each record to the enabled
 * sinks. Without metrics, identical exposure tuples are pre-deduped per revision, except
 * that RUM-eligible records always go through when main correlates RUM (R2): RUM needs every
 * evaluation time, and `doLog: false` only concerns exposures.
 * Transport and timers are injected, so the same logic runs in any runtime.
 */
export class EvaluationReporter {
  /** Queued records (read by tests through the providers). */
  records: EvaluationRecord[] = [];
  private errors: { message: string; stack?: string }[] = [];
  /** Records dropped before sending (larger than the batch bound on their own), reported in the next batch. */
  private droppedCount = 0;
  private readonly preDedupeKeys = new Set<string>();
  private tracking: FlagsTracking = { exposures: false, rum: false, evaluations: false };
  private flushTimer: unknown;
  private closed = false;

  constructor(private readonly deps: EvaluationReporterDependencies) {}

  setTracking(tracking: FlagsTracking): void {
    this.tracking = tracking;
  }

  /** Whether records would be delivered at all under the current tracking toggles. */
  get active(): boolean {
    return !this.closed && (this.tracking.exposures || this.tracking.evaluations || this.rumViaMain);
  }

  /** RUM correlation for these records is done in main and enabled. */
  private get rumViaMain(): boolean {
    return this.deps.rumViaMain === true && this.tracking.rum;
  }

  /** Queue a record, applying the tracking toggles and exposure-only pre-dedupe. */
  add(record: EvaluationRecord): void {
    if (!this.active) {
      return;
    }
    if (!this.tracking.evaluations && !(this.rumViaMain && isRumEligible(record))) {
      // No metrics and no main-side RUM need: main only needs one record per exposure tuple and revision.
      const exposureEligible =
        this.tracking.exposures &&
        record.errorCode === undefined &&
        record.reason !== 'ERROR' &&
        record.variant !== undefined;
      if (!exposureEligible || !record.doLog) {
        return;
      }
      const key = JSON.stringify([
        record.contextRevision,
        record.flagKey,
        record.variant,
        record.allocationKey,
        record.configurationId,
      ]);
      if (this.preDedupeKeys.has(key)) {
        return;
      }
      this.preDedupeKeys.add(key);
      if (this.preDedupeKeys.size > MAX_PREDEDUPE_KEYS) {
        this.preDedupeKeys.delete(this.preDedupeKeys.values().next().value as string);
      }
    }
    this.records.push(record);
    if (this.records.length >= FLUSH_THRESHOLD) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /** Buffer an SDK error (message and stack bounded) for the next batch. */
  reportError(error: unknown): void {
    if (this.closed) {
      return;
    }
    if (this.errors.length < MAX_ERRORS_PER_BATCH) {
      const message = error instanceof Error ? error.message : String(error);
      const entry: { message: string; stack?: string } = { message: message.slice(0, MAX_BATCH_ERROR_MESSAGE_LENGTH) };
      if (error instanceof Error && typeof error.stack === 'string') {
        entry.stack = error.stack.slice(0, MAX_BATCH_ERROR_MESSAGE_LENGTH);
      }
      this.errors.push(entry);
    }
    try {
      this.scheduleFlush();
    } catch {
      // The timer is unavailable: errors ride along with the next batch.
    }
  }

  /**
   * Send queued records and errors in batches of at most {@link MAX_RECORDS_PER_BATCH}
   * records and {@link MAX_BATCH_BYTES} UTF-8 bytes of the complete serialized envelope
   * (R4); errors and the dropped-record count ride along with the first batch. A record
   * that alone does not fit an envelope is dropped and counted in `droppedCount`.
   */
  flush(): void {
    if (this.records.length === 0 && this.errors.length === 0 && this.droppedCount === 0) {
      return;
    }
    const records = this.records;
    let droppedCount = this.droppedCount;
    this.records = [];
    this.droppedCount = 0;
    const serialized: { json: string; bytes: number }[] = [];
    for (const record of records) {
      const json = JSON.stringify(record);
      const bytes = utf8ByteLength(json);
      if (EMPTY_ENVELOPE_BYTES + bytes > MAX_BATCH_BYTES) {
        droppedCount += 1;
      } else {
        serialized.push({ json, bytes });
      }
    }
    let errorsJson = this.errors.length > 0 ? JSON.stringify(this.errors) : undefined;
    this.errors = [];
    let batch: string[] = [];
    // The envelope is built by concatenation, so its byte size is the sum of its parts.
    const envelope = () =>
      `{"records":[${batch.join(',')}]` +
      (errorsJson !== undefined ? `,"errors":${errorsJson}` : '') +
      (droppedCount > 0 ? `,"droppedCount":${droppedCount}` : '') +
      '}';
    let envelopeBytes = utf8ByteLength(envelope());
    const send = () => {
      this.deps.send(envelope());
      batch = [];
      errorsJson = undefined;
      droppedCount = 0;
      envelopeBytes = EMPTY_ENVELOPE_BYTES;
    };
    for (const { json, bytes } of serialized) {
      if (
        batch.length >= MAX_RECORDS_PER_BATCH ||
        envelopeBytes + bytes + (batch.length > 0 ? 1 : 0) > MAX_BATCH_BYTES
      ) {
        // An empty-records envelope is sent only when the errors and count alone leave no room.
        send();
      }
      envelopeBytes += bytes + (batch.length > 0 ? 1 : 0);
      batch.push(json);
    }
    if (batch.length > 0 || errorsJson !== undefined || droppedCount > 0) {
      send();
    }
  }

  /** Flush, clear the timer and stop accepting records and errors. */
  close(): void {
    this.flush();
    this.closed = true;
    if (this.flushTimer !== undefined) {
      this.deps.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer === undefined && !this.closed) {
      this.flushTimer = this.deps.setTimeout(() => {
        this.flushTimer = undefined;
        try {
          this.flush();
        } catch (error) {
          this.reportError(error);
        }
      }, FLUSH_INTERVAL);
    }
  }
}

/** The records main RUM correlation uses: a resolved variant and no error (mirrors the fan-out). */
function isRumEligible(record: EvaluationRecord): boolean {
  return record.variant !== undefined && record.errorCode === undefined;
}
