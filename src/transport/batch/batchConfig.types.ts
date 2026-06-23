import { EventTrack } from '../../event';

/**
 * Top-level configuration for a single batch track managed by {@link BatchManager}.
 * Combines producer, consumer, and scheduling parameters.
 */
export interface BatchConfig {
  /** Base directory under which per-track subdirectories are created. */
  path: string;
  /** The event track this batch pipeline serves (e.g. RUM, spans). */
  trackType: EventTrack;
  /** Maximum byte size of a single batch file before it is rotated. */
  batchSize: number;
  /** Milliseconds between upload cycles. */
  uploadFrequency: number;
}
