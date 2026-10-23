import fs from 'node:fs/promises';
import path from 'node:path';
import type { StandardServerEvent } from '../../../event';
import { BatchProducer } from '../BatchProducer';
import type { BatchProducerConfig } from '../BatchProducer';

/** Configuration for a {@link StandardBatchProducer} instance. */
export interface StandardBatchProducerConfig extends BatchProducerConfig {
  /** Maximum byte size of a single batch file before it is rotated. */
  batchSize: number;
  /** Optional maximum number of events in a batch file before it is rotated. */
  maxEventsPerBatch?: number;
}

/**
 * Concrete {@link BatchProducer} that serializes events as newline-delimited JSON
 * and appends them to `.tmp` batch files on disk, rotating by size.
 */
export class StandardBatchProducer extends BatchProducer {
  private batchSize: number;
  private maxEventsPerBatch: number | undefined;
  private currentBatchFile: string | null = null;
  private currentBatchSize = 0;
  private currentBatchEventCount = 0;

  private constructor(config: StandardBatchProducerConfig) {
    super(config);
    this.batchSize = config.batchSize;
    this.maxEventsPerBatch = config.maxEventsPerBatch;
  }

  /**
   * Creates and fully initializes a StandardBatchProducer.
   * Ensures the track directory exists and rotates any orphaned `.tmp` files
   * left from previous sessions.
   */
  static async create(config: StandardBatchProducerConfig): Promise<BatchProducer> {
    const producer = new StandardBatchProducer(config);
    await producer.initialize();
    return producer;
  }

  /** Drains pending writes and rotates the current batch file to `.log`. */
  override async flush() {
    await this.writeQueue;
    await this.rotateBatch();
  }

  /** Serializes the event's `data` as a JSON line and appends it to the current batch file, rotating first if the size limit would be exceeded. */
  protected async writeData(event: StandardServerEvent) {
    await this.ensureTrackDirectoryExists();

    const serialized = `${JSON.stringify(event.data)}\n`;
    const dataSize = Buffer.byteLength(serialized, 'utf8');

    const exceedsByteLimit = this.currentBatchSize + dataSize > this.batchSize;
    const reachedEventLimit =
      this.maxEventsPerBatch !== undefined && this.currentBatchEventCount >= this.maxEventsPerBatch;
    if (this.currentBatchSize > 0 && (exceedsByteLimit || reachedEventLimit)) {
      await this.rotateBatch();
    }

    const batchPath = this.getCurrentBatchPath();
    await fs.appendFile(batchPath, serialized, 'utf8');
    this.currentBatchSize += dataSize;
    this.currentBatchEventCount++;
  }

  /** Returns the full path to the current batch file, creating a new name if needed. */
  private getCurrentBatchPath() {
    if (!this.currentBatchFile) {
      this.currentBatchFile = this.generateBatchFileName();
    }
    return path.join(this.trackPath, this.currentBatchFile);
  }

  /** Renames the current `.tmp` batch file to `.log` and resets the batch state. */
  private async rotateBatch() {
    if (!this.currentBatchFile) {
      return;
    }
    await this.renameBatchFile(this.currentBatchFile);
    this.currentBatchFile = null;
    this.currentBatchSize = 0;
    this.currentBatchEventCount = 0;
  }
}
