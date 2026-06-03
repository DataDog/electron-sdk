import { dateNow } from '@datadog/browser-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BatchProducerConfig } from './types';

/**
 * Writes serialized event data to `.tmp` batch files on disk.
 * When the current file exceeds {@link BatchProducerConfig.batchSize}, it is rotated
 * (renamed from `.tmp` to `.log`) so the {@link BatchConsumer} can pick it up.
 */
export abstract class BatchProducer {
  protected trackPath: string;
  protected batchSize: number;
  protected currentBatchFile: string | null = null;
  protected currentBatchSize = 0;
  protected writeQueue: Promise<void> = Promise.resolve();

  protected constructor(config: BatchProducerConfig) {
    this.trackPath = config.trackPath;
    this.batchSize = config.batchSize;
  }

  /** Enqueues data to be appended to the current batch file. Writes are serialized. */
  post(data: unknown) {
    this.writeQueue = this.writeQueue
      .then(() => this.writeData(data))
      .catch(() => {
        // Silently ignore write errors to ensure the queue continues processing
      });
  }

  /** Waits for pending writes to complete and rotates the current batch file. */
  async flush() {
    await this.writeQueue;
    await this.rotateBatch();
  }

  /** Creates the track directory if it does not already exist. */
  protected async ensureTrackDirectoryExists() {
    try {
      await fs.access(this.trackPath);
    } catch {
      await fs.mkdir(this.trackPath, { recursive: true });
    }
  }

  /** Renames any leftover `.tmp` files from prior sessions to `.log` so the consumer can upload them. */
  protected async rotateOrphanedBatches() {
    try {
      const files = await fs.readdir(this.trackPath);
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          await this.renameBatchFile(file);
        }
      }
    } catch {
      // Directory read failed — nothing to recover
    }
  }

  /** Generates a timestamp-based `.tmp` file name for a new batch. */
  protected generateBatchFileName() {
    return `batch-${dateNow()}.tmp`;
  }

  /** Returns the full path to the current batch file, creating a new name if needed. */
  protected getCurrentBatchPath() {
    if (!this.currentBatchFile) {
      this.currentBatchFile = this.generateBatchFileName();
    }
    return path.join(this.trackPath, this.currentBatchFile);
  }

  /** Renames the current `.tmp` batch file to `.log` and resets the batch state. */
  protected async rotateBatch() {
    if (!this.currentBatchFile) {
      return;
    }
    await this.renameBatchFile(this.currentBatchFile);
    this.currentBatchFile = null;
    this.currentBatchSize = 0;
  }

  /** Renames a `.tmp` batch file to `.log` so the consumer can pick it up. */
  protected async renameBatchFile(file: string) {
    const tmpPath = path.join(this.trackPath, file);
    const logPath = tmpPath.replace(/\.tmp$/, '.log');

    try {
      await fs.access(tmpPath);
      await fs.rename(tmpPath, logPath);
    } catch {
      // File doesn't exist or rename failed - silently ignore
    }
  }

  /** Serializes data as a JSON line and appends it to the current batch file, rotating first if the size limit would be exceeded. */
  protected abstract writeData(data: unknown): Promise<void>;
}
