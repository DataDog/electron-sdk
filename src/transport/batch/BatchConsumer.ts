import fs from 'node:fs/promises';
import path from 'node:path';
import { display } from '../../tools/display';
import { getUserAgent } from '../userAgent';
import { compareBatchFileNames } from './batchFileName';

/** Configuration for a {@link BatchConsumer} instance. */
export interface BatchConsumerConfig {
  /** Absolute path to the directory where batch files are read from. */
  trackPath: string;
  /** Full intake URL to POST batch data to. */
  intakeUrl: string;
  /** Datadog client token sent as `DD-API-KEY`. */
  clientToken: string;
}

/**
 * Reads rotated `.log` batch files from disk, parses their newline-delimited JSON
 * content, and uploads the events to the Datadog intake endpoint.
 * Successfully uploaded files are deleted from disk.
 */
export abstract class BatchConsumer {
  protected trackPath: string;
  protected intakeUrl: string;
  protected clientToken: string;
  protected userAgent: string | undefined;
  private readFailureWarnedPaths = new Set<string>();

  constructor(config: BatchConsumerConfig) {
    this.trackPath = config.trackPath;
    this.intakeUrl = config.intakeUrl;
    this.clientToken = config.clientToken;
  }

  /** Uploads completed authorized `.log` files to the intake endpoint. */
  async upload() {
    if (!this.userAgent) {
      this.userAgent = getUserAgent();
    }

    const logFiles = await this.getLogFiles();
    const listedPaths = new Set(logFiles);
    for (const warnedPath of this.readFailureWarnedPaths) {
      if (!listedPaths.has(warnedPath)) {
        this.readFailureWarnedPaths.delete(warnedPath);
      }
    }

    for (const logFile of logFiles) {
      await this.uploadBatch(logFile);
    }
  }

  /**
   * Returns paths of all `.log` files in the track directory, oldest first.
   * File names embed a timestamp and an unpadded sequence (`batch-<ms>-<seq>`), so they are ordered
   * with a numeric-aware compare (a plain lexical sort would rank `-10` before `-9`).
   */
  protected async getLogFiles() {
    try {
      await fs.access(this.trackPath);
      const files = await fs.readdir(this.trackPath);
      return files
        .filter((file) => file.endsWith('.log'))
        .map((file) => path.join(this.trackPath, file))
        .sort(compareBatchFileNames);
    } catch {
      return [];
    }
  }

  /**
   * Reads a batch file and returns its non-empty lines, or `undefined` when the read fails, so the file is kept and
   * retried on the next upload cycle instead of being dropped as an empty batch. A failure warns once per file while
   * the file stays listed; a file that no longer exists (`ENOENT`, e.g. evicted by the cap after being listed) is
   * skipped silently.
   */
  protected async readBatchFile(filePath: string): Promise<string[] | undefined> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.split('\n').filter((line) => line.trim().length > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !this.readFailureWarnedPaths.has(filePath)) {
        this.readFailureWarnedPaths.add(filePath);
        display.warn('Failed to read batch file, keeping it for the next upload:', filePath, error);
      }
      return undefined;
    }
  }

  /**
   * Reads a batch file, delegates request construction to {@link buildRequest},
   * sends it, and deletes the file on success.
   * If {@link buildRequest} returns `null` the file is deleted without a network call
   * (empty or malformed batch — nothing to send).
   * If the file cannot be read it is kept for the next upload cycle and `false` is returned.
   */
  protected async uploadBatch(filePath: string): Promise<boolean> {
    const lines = await this.readBatchFile(filePath);
    if (!lines) {
      return false;
    }
    const request = await this.buildRequest(lines);

    if (!request) {
      await fs.unlink(filePath).catch(() => undefined);
      return true;
    }

    try {
      const response = await fetch(request);
      if (response.ok) {
        await fs.unlink(filePath);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Builds the HTTP {@link Request} for the given batch file lines.
   * Return `null` if the lines produce no sendable payload — the base class
   * will delete the file and skip the network call.
   * May be async to allow payload transforms (e.g. compression).
   */
  protected abstract buildRequest(lines: string[]): Promise<Request | null> | Request | null;
}
