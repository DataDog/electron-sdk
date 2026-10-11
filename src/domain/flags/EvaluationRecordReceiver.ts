import { ipcMain } from 'electron';
import { monitor } from '../telemetry';
import { FLAGS_EVALUATIONS_CHANNEL } from '../../common';
import type { EvaluationRecord } from '../../common/flags/types';
import { EvaluationBatchIntake } from './EvaluationBatchIntake';

export {
  MAX_BATCH_JSON_LENGTH,
  DROPPED_RECORDS_DEBUG_INTERVAL,
  DROPPED_RECORDS_DEBUG_MESSAGE,
} from './EvaluationBatchIntake';

export interface EvaluationRecordReceiverDependencies {
  /** The shared tracking fan-out: every enabled sink (exposures, metrics) receives the record. */
  onRecord: (record: EvaluationRecord) => void;
  /** Origin gate plus session exclusion (P1): `false` drops the payload silently. */
  isAllowedSender: (
    senderFrame: { origin: string; url: string } | undefined,
    sender: Electron.WebContents | undefined
  ) => boolean;
  /** Shared batch intake (rate-limited drop telemetry); one is created when omitted. */
  intake?: EvaluationBatchIntake;
}

/**
 * Main-process intake of renderer evaluation records (M4.9). Accepts JSON batches from
 * renderer frames gated by the same origin check as the RUM bridge, and hands them to the
 * shared {@link EvaluationBatchIntake}, which validates them with partial acceptance,
 * forwards valid records to the tracking fan-out, reports renderer errors to telemetry and
 * reports dropped records as count-only, rate-limited debug telemetry.
 */
export class EvaluationRecordReceiver {
  private readonly intake: EvaluationBatchIntake;
  private readonly listener = monitor((event: Electron.IpcMainEvent, json: unknown) => {
    if (!this.deps.isAllowedSender(event.senderFrame ?? undefined, event.sender)) {
      // A payload from a disallowed origin is dropped silently, as on the RUM bridge.
      return;
    }
    this.intake.receive(json, 'renderer');
  });

  constructor(private readonly deps: EvaluationRecordReceiverDependencies) {
    this.intake = deps.intake ?? new EvaluationBatchIntake((record) => deps.onRecord(record));
  }

  /** Register the IPC listener. Call at init. */
  start(): void {
    ipcMain.on(FLAGS_EVALUATIONS_CHANNEL, this.listener);
  }

  /** Remove the IPC listener. */
  stop(): void {
    ipcMain.removeListener(FLAGS_EVALUATIONS_CHANNEL, this.listener);
  }
}
