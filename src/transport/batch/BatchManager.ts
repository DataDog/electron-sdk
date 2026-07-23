import path from 'node:path';
import { setTimeout } from '@datadog/browser-core';
import type { Configuration } from '../../config';
import { addError } from '../../domain/telemetry';
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

/**
 * Coordinates a {@link BatchProducer} and {@link BatchConsumer} pair for a single track type.
 * Runs a periodic upload cycle that rotates pending `.tmp` files to `.log` and
 * delivers them to the intake endpoint.
 */
export class BatchManager {
  private producer: BatchProducer;
  private consumer: BatchConsumer;
  private uploadFrequency: number;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  // The upload cycle currently running (rotate + upload), or null when idle.
  private activeCycle: Promise<void> | null = null;
  // A cycle queued to run after the active one. Concurrent flush() callers coalesce onto it.
  private queuedCycle: Promise<void> | null = null;

  private constructor(producer: BatchProducer, consumer: BatchConsumer, uploadFrequency: number) {
    this.producer = producer;
    this.consumer = consumer;
    this.uploadFrequency = uploadFrequency;
  }

  /** Creates and fully initializes a BatchManager instance. */
  static async create(config: Configuration, batchConfig: BatchConfig) {
    const { uploadFrequency } = batchConfig;

    const { producer, consumer } = await BatchManager.createProducerConsumerPair(config, batchConfig);
    const manager = new BatchManager(producer, consumer, uploadFrequency);
    manager.start();

    return manager;
  }

  /** Enqueues a server event to be written to the current batch file. */
  post(event: ServerEvent) {
    this.producer.post(event);
  }

  /**
   * Drains the write queue, rotates the current batch, and uploads all pending files.
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
        .catch((error) => addError(error))
        .then(() => this.scheduleNext());
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

  /** Flushes the producer to rotate pending files, then uploads all ready batches. */
  private async runUploadCycle() {
    try {
      // Flush producer first to rotate any pending .tmp files to .log
      await this.producer.flush();
      // Then upload all .log files
      await this.consumer.upload();
    } finally {
      this.activeCycle = null;
    }
  }

  /**
   * Creates the appropriate {@link BatchProducer} / {@link BatchConsumer} pair for the
   * given track type. Add a new branch here when introducing a new transport strategy.
   *
   * Each producer narrows `writeData()` to its track's event shape, so a mismatched pairing
   * fails only at runtime. Keep each branch in sync with `Transport.setupTrackBatching`.
   */
  private static async createProducerConsumerPair(
    config: Configuration,
    batchConfig: BatchConfig
  ): Promise<{ producer: BatchProducer; consumer: BatchConsumer }> {
    const { clientToken } = config;
    const { path: configPath, trackType, batchSize } = batchConfig;

    const trackPath = path.join(configPath, trackType);
    const intakeUrl = computeIntakeUrlForTrack(config.site, trackType, { proxy: config.proxy });

    const consumerConfig: BatchConsumerConfig = { trackPath, intakeUrl, clientToken };

    if (trackType === EventTrack.REPLAY) {
      const producer = await ReplayBatchProducer.create({ trackPath });
      const consumer = new ReplayBatchConsumer(consumerConfig);
      return { producer, consumer };
    }

    if (trackType === EventTrack.PROFILE) {
      const producer = await ProfileBatchProducer.create({ trackPath });
      const consumer = new ProfileBatchConsumer(consumerConfig);
      return { producer, consumer };
    }

    const standardProducerConfig: StandardBatchProducerConfig = { trackPath, batchSize };
    const producer = await StandardBatchProducer.create(standardProducerConfig);
    const consumer = new StandardBatchConsumer(consumerConfig);
    return { producer, consumer };
  }
}
