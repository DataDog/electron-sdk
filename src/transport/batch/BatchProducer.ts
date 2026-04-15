import { app } from 'electron';
import { dateNow } from '@datadog/browser-core';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ProducerConfig {
  trackPath: string;
  batchSize: number;
}

/**
 * Writes serialized event data to `.tmp` batch files on disk.
 * When the current file exceeds {@link ProducerConfig.batchSize}, it is rotated
 * (renamed from `.tmp` to `.log`) so the {@link BatchConsumer} can pick it up.
 */
export class BatchProducer {
  private trackPath: string;
  private batchSize: number;
  private currentBatchFile: string | null = null;
  private currentBatchSize = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(config: ProducerConfig) {
    this.trackPath = config.trackPath;
    this.batchSize = config.batchSize;
  }

  /** Creates and fully initializes a BatchProducer instance. */
  static async create(config: ProducerConfig) {
    const producer = new BatchProducer(config);
    await producer.ensureTrackDirectoryExists();
    // rotate any leftover data so we start from a clean state
    await producer.flush();

    return producer;
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
  private async ensureTrackDirectoryExists() {
    try {
      await fs.access(this.trackPath);
    } catch {
      await fs.mkdir(this.trackPath, { recursive: true });
    }
  }

  /** Generates a timestamp-based `.tmp` file name for a new batch. */
  private generateBatchFileName() {
    return `batch-${dateNow()}.tmp`;
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

    const tmpPath = path.join(this.trackPath, this.currentBatchFile);
    const logPath = tmpPath.replace(/\.tmp$/, '.log');

    try {
      await fs.access(tmpPath);
      await fs.rename(tmpPath, logPath);
    } catch {
      // File doesn't exist or rename failed - silently ignore
    }

    this.currentBatchFile = null;
    this.currentBatchSize = 0;
  }

  /** Serializes data as a JSON line and appends it to the current batch file, rotating first if the size limit would be exceeded. */
  private async writeData(data: unknown) {
    await this.ensureTrackDirectoryExists();

    const serialized = `${sanitizeAppPaths(JSON.stringify(data))}\n`;
    const dataSize = Buffer.byteLength(serialized, 'utf8');

    if (this.currentBatchSize + dataSize > this.batchSize && this.currentBatchSize > 0) {
      await this.rotateBatch();
    }

    const batchPath = this.getCurrentBatchPath();
    await fs.appendFile(batchPath, serialized, 'utf8');
    this.currentBatchSize += dataSize;
  }
}

let appPathPattern: RegExp | undefined;

function sanitizeAppPaths(json: string): string {
  if (!appPathPattern) {
    try {
      // Escape special regex chars in the path, match both raw and JSON-escaped separators
      const appPath = app.getAppPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = appPath.split('/').join('[\\\\/]');
      appPathPattern = new RegExp(pattern, 'g');
    } catch {
      return json;
    }
  }
  return json.replace(appPathPattern, '');
}
