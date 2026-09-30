import type { Configuration } from '../../config';
import { addError, clearTimeout, monitor, setTimeout } from '../../domain/telemetry';
import type { TrackingConsentManager } from '../../domain/tracking-consent';
import { EventTrack } from '../../event';
import type { ServerEvent } from '../../event';
import { computeIntakeUrlForTrack } from '../utils';
import { BatchConsumer } from './BatchConsumer';
import type { BatchConsumerConfig } from './BatchConsumer';
import { BatchProducer } from './BatchProducer';
import { ProfileBatchConsumer, ProfileBatchProducer } from './profiling';
import { ReplayBatchConsumer } from './replay/ReplayBatchConsumer';
import { ReplayBatchProducer } from './replay/ReplayBatchProducer';
import { StandardBatchConsumer } from './standard/StandardBatchConsumer';
import { StandardBatchProducer } from './standard/StandardBatchProducer';
import type { StandardBatchProducerConfig } from './standard/StandardBatchProducer';
import type { BatchConfig } from './batchConfig.types';
import { ConsentAwareBatchProducer } from './ConsentAwareBatchProducer';
import { getTrackPath } from './batchPaths';

/** Maximum array length accepted by the Logs HTTP intake. */
const MAX_LOGS_EVENTS_PER_BATCH = 1_000;

/**
 * Coordinates consent-aware disk writes and uploads for a single track type.
 * The consent router selects the writer; the consumer reads only authorized batches at the track root.
 */
export class BatchManager {
  private producer: ConsentAwareBatchProducer;
  private consumer: BatchConsumer;
  private uploadFrequency: number;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  // The upload cycle currently running (rotate + upload), or null when idle.
  private activeCycle: Promise<void> | null = null;
  // A cycle queued to run after the active one. Concurrent flush() callers coalesce onto it.
  private queuedCycle: Promise<void> | null = null;

  private constructor(producer: ConsentAwareBatchProducer, consumer: BatchConsumer, uploadFrequency: number) {
    this.producer = producer;
    this.consumer = consumer;
    this.uploadFrequency = uploadFrequency;
  }

  /** Creates and fully initializes a BatchManager instance. */
  static async create(config: Configuration, batchConfig: BatchConfig, consentManager: TrackingConsentManager) {
    const { uploadFrequency } = batchConfig;
    const trackPath = getTrackPath(batchConfig.path, batchConfig.trackType);
    const authorizedProducer = await BatchManager.createProducer(batchConfig, trackPath);
    const producer = new ConsentAwareBatchProducer(
      authorizedProducer,
      trackPath,
      (directory) => BatchManager.createProducer(batchConfig, directory),
      consentManager
    );
    const consumer = BatchManager.createConsumer(config, batchConfig.trackType, trackPath);
    const manager = new BatchManager(producer, consumer, uploadFrequency);
    manager.start();

    return manager;
  }

  /** Enqueues a server event to be written to the current batch file. */
  post(event: ServerEvent) {
    this.producer.post(event);
  }

  /**
   * Drains writes, rotates current batches, and uploads authorized files awaiting delivery.
   *
   * Guarantees a full cycle runs to completion *after* this call. A scheduled cycle already in
   * flight may have scanned the directory before the caller rotated new files (e.g. the final
   * replay segment flushed on quit), so we always run a fresh cycle behind it rather than
   * short-circuiting — otherwise those files would sit on disk until the next launch.
   */
  async flush() {
    await this.enqueueUploadCycle();
  }

  /** Stops the periodic upload cycle. */
  stop() {
    this.producer.stop();
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /** Kicks off the first scheduled cycle. */
  private start() {
    this.scheduleNext();
  }

  /** Schedules the next upload cycle after the configured frequency delay. */
  private scheduleNext() {
    this.timeoutId = setTimeout(() => {
      void this.runPeriodicCycle()
        .catch(monitor((error) => addError(error)))
        .then(monitor(() => this.scheduleNext()));
    }, this.uploadFrequency);
  }

  /**
   * Periodic tick: run a cycle only when nothing is active or queued, so ticks never stack up
   * behind a slow upload (a fresh tick will fire next interval anyway).
   */
  private runPeriodicCycle(): Promise<void> {
    if (this.activeCycle || this.queuedCycle) {
      return this.activeCycle ?? Promise.resolve();
    }
    return this.enqueueUploadCycle();
  }

  /**
   * Queues an upload cycle to run after any in-flight one. Multiple callers before the queued
   * cycle starts share the same promise, so at most one cycle is ever pending and cycles never
   * overlap (rotate + upload touch the same directory).
   */
  private enqueueUploadCycle(): Promise<void> {
    if (this.queuedCycle) {
      return this.queuedCycle;
    }

    const previous = this.activeCycle ?? Promise.resolve();
    const cycle = previous
      // Swallow the prior cycle's failure — its own scheduler already reported it, and this
      // cycle must still run so newly rotated files get uploaded.
      .catch(() => undefined)
      .then(() => {
        this.queuedCycle = null;
        this.activeCycle = this.runUploadCycle();
        return this.activeCycle;
      });
    this.queuedCycle = cycle;
    return cycle;
  }

  /** Closes open batch files, then uploads authorized batches. */
  private async runUploadCycle() {
    try {
      // Seal open batches before scanning the authorized directory.
      await this.producer.flush();
      await this.consumer.upload();
    } finally {
      this.activeCycle = null;
    }
  }

  /**
   * Uses the same serialization and file limits for both consent stores of a track.
   */
  private static createProducer(batchConfig: BatchConfig, trackPath: string): Promise<BatchProducer> {
    const { trackType, batchSize } = batchConfig;
    if (trackType === EventTrack.REPLAY) {
      return ReplayBatchProducer.create({ trackPath });
    }

    if (trackType === EventTrack.PROFILE) {
      return ProfileBatchProducer.create({ trackPath });
    }

    const standardProducerConfig: StandardBatchProducerConfig = {
      trackPath,
      batchSize,
      ...(trackType === EventTrack.LOGS ? { maxEventsPerBatch: MAX_LOGS_EVENTS_PER_BATCH } : {}),
    };
    return StandardBatchProducer.create(standardProducerConfig);
  }

  /** The consumer scans the track root, never pending stores or migration directories. */
  private static createConsumer(config: Configuration, trackType: EventTrack, trackPath: string): BatchConsumer {
    const consumerConfig: BatchConsumerConfig = {
      trackPath,
      intakeUrl: computeIntakeUrlForTrack(config.site, trackType, { proxy: config.proxy }),
      clientToken: config.clientToken,
    };
    if (trackType === EventTrack.REPLAY) {
      return new ReplayBatchConsumer(consumerConfig);
    }
    if (trackType === EventTrack.PROFILE) {
      return new ProfileBatchConsumer(consumerConfig);
    }
    return new StandardBatchConsumer(consumerConfig);
  }
}
