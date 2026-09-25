import { dateNow } from '@datadog/js-core/time';
import fs from 'node:fs/promises';
import path from 'node:path';
import { display } from '../../tools/display';
import { compareBatchFileNames } from './batchFileName';

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
   * Maximum number of pending `.log` files kept on disk. Beyond this, the oldest are evicted.
   * Last-resort bound against unbounded growth when uploads fail for a long time. Subclasses may override.
   *
   * Writes and flushes enforce this bound on a best-effort basis. Files can temporarily exceed the
   * cap during rotation or migration, or while filesystem errors prevent eviction.
   */
  protected maxLogFiles = 100;
  private fileSequence = 0;

  protected constructor(config: BatchProducerConfig) {
    this.trackPath = config.trackPath;
  }

  /** Enqueues data to be appended once its storage is ready. Writes are serialized. */
  post(data: unknown, storageReadiness?: Promise<boolean>) {
    void this.enqueueOperation(async () => {
      if (storageReadiness && !(await storageReadiness)) {
        return;
      }
      try {
        await this.writeData(data);
      } catch (error) {
        // Disk write failure is an environment issue the SDK cannot fix (disk full, permissions):
        // surface it to the customer and keep the queue alive.
        display.error('Failed to write batch to disk', error);
      }
      // Evict even when the write failed: a full disk (ENOSPC) is exactly when trimming the backlog
      // frees space for subsequent writes to succeed.
      await this.evictOverflow();
    });
  }

  /** Waits for pending writes, seals any open batch, and trims completed files to the disk limit. */
  flush(): Promise<void> {
    return this.enqueueOperation(async () => {
      await this.flushData();
      await this.evictOverflow();
    });
  }

  /** Seals earlier writes and runs an operation before accepting later writes. */
  runAfterFlush(operation: () => Promise<void>): Promise<void> {
    return this.enqueueOperation(async () => {
      await this.flushData();
      await operation();
    });
  }

  /** Clears storage after sealing earlier writes and successfully completing the prerequisite. */
  clearAfterFlush(prerequisite: () => Promise<void>): Promise<void> {
    return this.enqueueOperation(async () => {
      await this.flushData();
      await prerequisite();
      await fs.rm(this.trackPath, { recursive: true, force: true });
      await fs.mkdir(this.trackPath, { recursive: true });
      this.onStorageCleared();
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

  /**
   * Deletes the oldest `.log` files when the pending count exceeds {@link maxLogFiles}. Ordered
   * oldest-first via {@link compareBatchFileNames}. Never throws.
   *
   * Eviction is intentionally silent: it runs on every write, so logging each drop would spam
   * while the buffer stays full. The signal of a sustained outage is the upload failures, not this cap.
   *
   * May race with the consumer's upload cycle (both run on the shared event loop): a file selected for
   * upload can be evicted here mid-flight. That is safe — the consumer unlinks inside a try/catch, so a
   * now-missing file just yields a no-op and the upload cycle keeps processing the rest of the backlog.
   */
  private async evictOverflow() {
    let logFiles: string[];
    try {
      logFiles = (await fs.readdir(this.trackPath)).filter((file) => file.endsWith('.log')).sort(compareBatchFileNames);
    } catch {
      // Directory unreadable — nothing to evict
      return;
    }

    const overflow = logFiles.length - this.maxLogFiles;
    for (let i = 0; i < overflow; i++) {
      await fs.unlink(path.join(this.trackPath, logFiles[i])).catch(() => undefined);
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

  /** Resets subclass state that references files removed by {@link clearAfterFlush}. */
  protected onStorageCleared(): void {
    // Most producers do not retain file state between writes.
  }

  /** Seals producer-specific open data during {@link flush}. */
  protected flushData(): Promise<void> {
    return Promise.resolve();
  }

  protected abstract writeData(data: unknown): Promise<void>;
}
