import { dateNow } from '@datadog/browser-core';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Configuration for a {@link BatchProducer} instance. */
export interface BatchProducerConfig {
  /** Absolute path to the directory where batch files are written. */
  trackPath: string;
}

/**
 * Writes serialized event data to `.tmp` batch files on disk.
 * Subclasses implement {@link writeData} to control how each event is serialized and
 * when files are rotated.
 */
export abstract class BatchProducer {
  protected trackPath: string;
  protected writeQueue: Promise<void> = Promise.resolve();

  protected constructor(config: BatchProducerConfig) {
    this.trackPath = config.trackPath;
  }

  /** Enqueues data to be appended to the current batch file. Writes are serialized. */
  post(data: unknown) {
    this.writeQueue = this.writeQueue
      .then(() => this.writeData(data))
      .catch(() => {
        // Silently ignore write errors to ensure the queue continues processing
      });
  }

  /** Waits for all pending writes to complete. */
  async flush() {
    await this.writeQueue;
  }

  /** Ensures the track directory exists and rotates any orphaned `.tmp` files from prior sessions. */
  protected async initialize() {
    await this.ensureTrackDirectoryExists();
    await this.rotateOrphanedBatches();
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

  protected abstract writeData(data: unknown): Promise<void>;
}
