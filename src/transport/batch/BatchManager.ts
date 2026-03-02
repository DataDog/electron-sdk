import path from 'node:path';

import type { Configuration } from '../../config';
import { computeIntakeUrlForTrack } from '../../config';
import type { BatchManagerConfig } from './../transport.types';
import { BatchConsumer } from './BatchConsumer';
import { BatchProducer } from './BatchProducer';

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
  private isRunning = false;

  constructor(config: Configuration, batchConfig: BatchManagerConfig) {
    const { clientToken } = config;
    const { path: configPath, trackType, batchSize, uploadFrequency } = batchConfig;

    const trackPath = path.join(configPath, trackType);
    const intakeUrl = config.proxy ?? computeIntakeUrlForTrack(config.site, trackType);

    this.uploadFrequency = uploadFrequency;

    this.producer = new BatchProducer({
      trackPath,
      batchSize,
    });

    this.consumer = new BatchConsumer({
      trackPath,
      intakeUrl,
      clientToken,
    });
  }

  /** Initializes the producer's storage directory and starts the upload cycle. */
  async init() {
    await this.producer.init();
    this.start();
  }

  /** Enqueues data to be written to the current batch file. */
  post(data: unknown) {
    this.producer.post(data);
  }

  /** Drains the write queue, rotates the current batch, and uploads all pending files. */
  async flush() {
    await this.producer.flush();
    await this.consumer.upload();
  }

  /** Stops the periodic upload cycle. */
  stop() {
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /** Marks the manager as running and kicks off the first scheduled cycle. */
  private start() {
    this.isRunning = true;
    this.scheduleNext();
  }

  /** Schedules the next upload cycle after the configured frequency delay. */
  private scheduleNext() {
    if (!this.isRunning) {
      return;
    }

    this.timeoutId = setTimeout(() => {
      void this.uploadCycle().then(() => this.scheduleNext());
    }, this.uploadFrequency);
  }

  /** Flushes the producer to rotate pending files, then uploads all ready batches. */
  private async uploadCycle() {
    // Flush producer first to rotate any pending .tmp files to .log
    await this.producer.flush();
    // Then upload all .log files
    await this.consumer.upload();
  }
}
