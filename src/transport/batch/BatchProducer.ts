import { dateNow } from '@datadog/js-core/time';
import fs from 'node:fs/promises';
import path from 'node:path';
import { display } from '../../tools/display';
import { evictBatchFiles, MAX_BATCH_FILES } from './batchFileEviction';

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
  /** Prefix used for generated batch file names. Subclasses may override. */
  protected fileNamePrefix = 'batch';
  /**
   * Maximum number of completed `.log` batches kept in this directory. The oldest are evicted.
   * Last-resort bound against unbounded growth when uploads fail for a long time. Subclasses may override.
   *
   * Writes and flushes enforce this bound on a best-effort basis. Files can temporarily exceed the
   * cap during rotation or migration, or while filesystem errors prevent eviction.
   */
  protected maxLogFiles = MAX_BATCH_FILES;
  private fileSequence = 0;

  protected constructor(config: BatchProducerConfig) {
    this.trackPath = config.trackPath;
  }

  /** Enqueues data to be appended to the current batch file. Writes are serialized. */
  post(data: unknown) {
    void this.enqueueOperation(async () => {
      try {
        await this.writeData(data);
      } catch (error) {
        // Disk write failure is an environment issue the SDK cannot fix (disk full, permissions):
        // surface it to the customer and keep the queue alive.
        display.error('Failed to write batch to disk', error);
      }
      // Evict even when the write failed: a full disk (ENOSPC) is exactly when trimming the backlog
      // frees space for subsequent writes to succeed.
      await evictBatchFiles([this.trackPath], this.maxLogFiles);
    });
  }

  /** Waits for queued writes, seals any open batch, and trims completed files to the disk limit. */
  flush(): Promise<void> {
    return this.enqueueOperation(async () => {
      await this.flushData();
      await evictBatchFiles([this.trackPath], this.maxLogFiles);
    });
  }

  /** Keeps subsequent operations usable after a failure, while returning the original result. */
  private enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.catch(() => undefined);
    return result;
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

  /** Generates a unique `.tmp` file name for a new batch. */
  protected generateBatchFileName() {
    return `${this.fileNamePrefix}-${dateNow()}-${++this.fileSequence}.tmp`;
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

  /** Seals producer-specific open data during {@link flush}. */
  protected flushData(): Promise<void> {
    return Promise.resolve();
  }

  protected abstract writeData(data: unknown): Promise<void>;
}
