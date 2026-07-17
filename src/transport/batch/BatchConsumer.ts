import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserAgent } from '../userAgent';

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

  constructor(config: BatchConsumerConfig) {
    this.trackPath = config.trackPath;
    this.intakeUrl = config.intakeUrl;
    this.clientToken = config.clientToken;
  }

  /** Uploads all pending `.log` files to the intake endpoint. */
  async upload() {
    if (!this.userAgent) {
      this.userAgent = getUserAgent();
    }

    const logFiles = await this.getLogFiles();

    for (const logFile of logFiles) {
      await this.uploadBatch(logFile);
    }
  }

  /** Returns sorted paths of all `.log` files in the track directory. */
  protected async getLogFiles() {
    try {
      await fs.access(this.trackPath);
      const files = await fs.readdir(this.trackPath);
      return files
        .filter((file) => file.endsWith('.log'))
        .map((file) => path.join(this.trackPath, file))
        .sort();
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
   * sends it, and deletes the file on success.
   * If {@link buildRequest} returns `null` the file is deleted without a network call
   * (empty or malformed batch — nothing to send).
   */
  protected async uploadBatch(filePath: string): Promise<boolean> {
    const lines = await this.readBatchFile(filePath);
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
