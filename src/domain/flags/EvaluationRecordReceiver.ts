import { ipcMain } from 'electron';
import { monitor, addError as addTelemetryError, addDebug as addTelemetryDebug } from '../telemetry';
import { parseEvaluationBatch } from '../../common/flags/flagsPayloads';
import { FLAGS_EVALUATIONS_CHANNEL } from '../../common';
import type { EvaluationRecord } from '../../common/flags/types';

export const MAX_BATCH_JSON_LENGTH = 64 * 1024;
export const DROPPED_RECORDS_DEBUG_INTERVAL = 10_000;
export const DROPPED_RECORDS_DEBUG_MESSAGE = 'flags: dropped evaluation records';

export interface EvaluationRecordReceiverDependencies {
  /** The shared tracking fan-out: every enabled sink (exposures, metrics) receives the record. */
  onRecord: (record: EvaluationRecord) => void;
  /** Origin gate plus session exclusion (P1): `false` drops the payload silently. */
  isAllowedSender: (
    senderFrame: { origin: string; url: string } | undefined,
    sender: Electron.WebContents | undefined
  ) => boolean;
}

/**
 * Main-process intake of renderer evaluation records (M4.9). Accepts JSON batches from
 * renderer frames gated by the same origin check as the RUM bridge, validates them with
 * partial acceptance (invalid records dropped and counted), forwards valid records to
 * the shared tracking fan-out and reports renderer errors to telemetry.
 *
 * Dropped records (malformed, oversize or non-string payloads, invalid records, records
 * beyond the per-batch cap) are reported as SDK debug telemetry with the count only,
 * at most once per {@link DROPPED_RECORDS_DEBUG_INTERVAL} per process (§3a); counts in
 * between are accumulated into the next report.
 */
export class EvaluationRecordReceiver {
  private lastDebugAt: number | undefined;
  private pendingDroppedCount = 0;
  private readonly listener = monitor((event: Electron.IpcMainEvent, json: unknown) => {
    this.receive(event, json);
  });

  constructor(private readonly deps: EvaluationRecordReceiverDependencies) {}

  /** Register the IPC listener. Call at init. */
  start(): void {
    ipcMain.on(FLAGS_EVALUATIONS_CHANNEL, this.listener);
  }

  /** Remove the IPC listener. */
  stop(): void {
    ipcMain.removeListener(FLAGS_EVALUATIONS_CHANNEL, this.listener);
  }

  private receive(event: Electron.IpcMainEvent, json: unknown): void {
    if (!this.deps.isAllowedSender(event.senderFrame ?? undefined, event.sender)) {
      // A payload from a disallowed origin is dropped silently, as on the RUM bridge.
      return;
    }
    const parsed = typeof json === 'string' ? parseEvaluationBatch(json, MAX_BATCH_JSON_LENGTH) : undefined;
    if (parsed === undefined) {
      this.reportDropped(1);
      return;
    }
    const { batch, droppedCount } = parsed;
    if (droppedCount > 0) {
      this.reportDropped(droppedCount);
    }
    // parseEvaluationBatch keeps at most 5 errors, messages and stacks truncated to 1024.
    for (const error of batch.errors ?? []) {
      addTelemetryError(toRendererError(error));
    }
    for (const record of batch.records) {
      this.deps.onRecord(record);
    }
  }

  private reportDropped(count: number): void {
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

/** Rebuild a renderer error with its bounded message and stack, tagged with its source. */
function toRendererError(error: { message: string; stack?: string }): Error {
  const rendererError = new Error(error.message);
  rendererError.name = 'RendererFlagsError';
  rendererError.stack = error.stack ?? `RendererFlagsError: ${error.message}`;
  return rendererError;
}
