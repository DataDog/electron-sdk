import type { LogSource } from '../../domain/logs';
import { EventTrack } from '../../event';

/**
 * Top-level configuration for a single batch track managed by {@link BatchManager}.
 * Combines producer, consumer, and scheduling parameters.
 */
export interface BatchConfig {
  /** Directory for this store’s persisted batches. */
  trackPath: string;
  /** The event track this batch pipeline serves (e.g. RUM, spans). */
  trackType: EventTrack;
  /** Source sent to the intake for this store. */
  intakeSource: LogSource;
  /** Maximum byte size of a single batch file before it is rotated. */
  batchSize: number;
  /** Milliseconds between upload cycles. */
  uploadFrequency: number;
}
