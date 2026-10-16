import { display } from '../../tools/display';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  /** Split logs rejected with HTTP 413, dropping only individually rejected logs. */
  splitOnPayloadTooLarge?: boolean;
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

  constructor(private readonly config: BatchConsumerConfig) {
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

  /** Reads a batch file and returns its non-empty lines. */
  protected async readBatchFile(filePath: string) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.split('\n').filter((line) => line.trim().length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Reads a batch file, delegates request construction to {@link buildRequest},
   * sends it, and deletes the file on success. Logs rejected with HTTP 413 are
   * retried in progressively smaller groups, preserving unfinished lines on disk.
   * If {@link buildRequest} returns `null` the file is deleted without a network call
   * (empty or malformed batch — nothing to send).
   */
  protected async uploadBatch(filePath: string): Promise<boolean> {
    let lines = await this.readBatchFile(filePath);
    let groupSize = lines.length;
    try {
      for (;;) {
        const request = await this.buildRequest(lines.slice(0, groupSize));
        if (request) {
          const response = await fetch(request);
          if (response.status === 413 && this.config.splitOnPayloadTooLarge) {
            if (groupSize > 1) {
              groupSize = Math.ceil(groupSize / 2);
              continue;
            }
            display.warn('Dropping log rejected individually by intake as too large (HTTP 413).');
          } else if (!response.ok) {
            return false;
          }
        }
        lines = lines.slice(groupSize);
        if (lines.length === 0) {
          await fs.unlink(filePath);
          return true;
        }
        // Checkpoint accepted/dropped groups before sending more. Use an atomic replacement:
        // a failed write must leave the original batch available for retry.
        await this.saveRemainingLines(filePath, lines);
        groupSize = Math.min(groupSize, lines.length);
      }
    } catch {
      return false;
    }
  }

  private async saveRemainingLines(filePath: string, lines: string[]): Promise<void> {
    // Uploads are serialized per store. Reuse one scratch file so interrupted checkpoints
    // cannot accumulate; .retry is never recovered as a completed batch.
    const temporaryPath = path.join(this.trackPath, 'upload.retry');
    try {
      await fs.writeFile(temporaryPath, `${lines.join('\n')}\n`, 'utf8');
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
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
