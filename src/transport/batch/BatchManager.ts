import path from 'node:path';
import { setTimeout } from '@datadog/browser-core';
import type { Configuration } from '../../config';
import { EventTrack } from '../../event';
import { addError } from '../../domain/telemetry';
import { computeIntakeUrlForTrack } from '../utils';
import { BatchConsumer } from './BatchConsumer';
import type { BatchConsumerConfig } from './BatchConsumer';
import { BatchProducer } from './BatchProducer';
import type { BatchProducerConfig } from './BatchProducer';
import { StandardBatchConsumer } from './standard/StandardBatchConsumer';
import { StandardBatchProducer } from './standard/StandardBatchProducer';
import type { StandardBatchProducerConfig } from './standard/StandardBatchProducer';
import { ReplayBatchConsumer } from './replay/ReplayBatchConsumer';
import { ReplayBatchProducer } from './replay/ReplayBatchProducer';
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
  private isUploading = false;

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

  /** Enqueues data to be written to the current batch file. */
  post(data: unknown) {
    this.producer.post(data);
  }

  /** Drains the write queue, rotates the current batch, and uploads all pending files. */
  async flush() {
    await this.triggerUploadCycle();
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
      void this.triggerUploadCycle()
        .catch((error) => addError(error))
        .then(() => this.scheduleNext());
    }, this.uploadFrequency);
  }

  /** Flushes the producer to rotate pending files, then uploads all ready batches. */
  private async triggerUploadCycle() {
    if (this.isUploading) {
      return;
    }

    this.isUploading = true;

    try {
      // Flush producer first to rotate any pending .tmp files to .log
      await this.producer.flush();
      // Then upload all .log files
      await this.consumer.upload();
    } finally {
      this.isUploading = false;
    }
  }

  /**
   * Creates the appropriate {@link BatchProducer} / {@link BatchConsumer} pair for the
   * given track type. Add a new branch here when introducing a new transport strategy.
   */
  private static async createProducerConsumerPair(
    config: Configuration,
    batchConfig: BatchConfig
  ): Promise<{ producer: BatchProducer; consumer: BatchConsumer }> {
    const { clientToken } = config;
    const { path: configPath, trackType, batchSize } = batchConfig;

    const trackPath = path.join(configPath, trackType);
    const intakeUrl = computeIntakeUrlForTrack(config.site, trackType, config.proxy);

    const baseProducerConfig: BatchProducerConfig = { trackPath };
    const consumerConfig: BatchConsumerConfig = { trackPath, intakeUrl, clientToken };

    if (trackType === EventTrack.REPLAY) {
      const producer = await ReplayBatchProducer.create(baseProducerConfig);
      const consumer = new ReplayBatchConsumer(consumerConfig);
      return { producer, consumer };
    }

    const standardProducerConfig: StandardBatchProducerConfig = { trackPath, batchSize };
    const producer = await StandardBatchProducer.create(standardProducerConfig);
    const consumer = new StandardBatchConsumer(consumerConfig);
    return { producer, consumer };
  }
}
