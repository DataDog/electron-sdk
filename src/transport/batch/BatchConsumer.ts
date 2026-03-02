import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConsumerConfig } from '../transport.types';

/**
 * Reads rotated `.log` batch files from disk, parses their newline-delimited JSON
 * content, and uploads the events to the Datadog intake endpoint.
 * Successfully uploaded files are deleted from disk.
 */
export class BatchConsumer {
  private trackPath: string;
  private intakeUrl: string;
  private clientToken: string;

  constructor(config: ConsumerConfig) {
    this.trackPath = config.trackPath;
    this.intakeUrl = config.intakeUrl;
    this.clientToken = config.clientToken;
  }

  /** Uploads all pending `.log` files to the intake endpoint. */
  async upload() {
    const logFiles = await this.getLogFiles();

    for (const logFile of logFiles) {
      await this.uploadBatch(logFile);
    }
  }

  /** Returns sorted paths of all `.log` files in the track directory. */
  private async getLogFiles() {
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
  private async readBatchFile(filePath: string) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.split('\n').filter((line) => line.trim().length > 0);
    } catch {
      return [];
    }
  }

  /** Parses a batch file's JSON lines and POSTs them to the intake. Deletes the file on success. */
  private async uploadBatch(filePath: string) {
    const lines = await this.readBatchFile(filePath);

    if (lines.length === 0) {
      try {
        await fs.unlink(filePath);
      } catch {
        // Ignore deletion errors for empty files
      }
      return true;
    }

    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((item) => item !== null);

    const body = JSON.stringify(events);

    try {
      const response = await fetch(this.intakeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'DD-API-KEY': this.clientToken,
        },
        body,
      });

      if (response.ok) {
        await fs.unlink(filePath);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }
}
