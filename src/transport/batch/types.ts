import { EventTrack } from '../../event';

/**
 * Top-level configuration for a single batch track managed by {@link BatchManager}.
 * Combines producer, consumer, and scheduling parameters.
 */
export interface BatchConfig {
  /** Base directory under which per-track subdirectories are created. */
  path: string;
  /** The event track this batch pipeline serves (e.g. RUM, session replay). */
  trackType: EventTrack;
  /** Maximum byte size of a single batch file before it is rotated. */
  batchSize: number;
  /** Milliseconds between upload cycles. */
  uploadFrequency: number;
}

/** Configuration for a {@link BatchProducer} instance. */
export interface BatchProducerConfig {
  /** Absolute path to the directory where batch files are written. */
  trackPath: string;
  /** Maximum byte size of a single batch file before it is rotated. */
  batchSize: number;
}

/** Configuration for a {@link BatchConsumer} instance. */
export interface BatchConsumerConfig {
  /** Absolute path to the directory where batch files are read from. */
  trackPath: string;
  /** Full intake URL to POST batch data to. */
  intakeUrl: string;
  /** Datadog client token sent as `DD-API-KEY`. */
  clientToken: string;
}
