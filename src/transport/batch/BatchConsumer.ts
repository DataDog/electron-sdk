import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserAgent } from '../userAgent';
import type { BatchConsumerConfig } from './types';

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

  /** Parses a batch file's JSON lines and POSTs them to the intake. Deletes the file on success. */
  protected abstract uploadBatch(filePath: string): Promise<boolean>;
}
