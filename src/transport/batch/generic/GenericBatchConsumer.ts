import fs from 'node:fs/promises';
import { BatchConsumer } from '../BatchConsumer';

/**
 * Concrete {@link BatchConsumer} for standard JSON event tracks (RUM, logs, etc.).
 *
 * Reads newline-delimited JSON from each `.log` batch file, assembles the
 * parsed events into a JSON array, and POSTs it to the Datadog intake endpoint.
 * Successfully uploaded files are deleted from disk.
 */
export class GenericBatchConsumer extends BatchConsumer {
  protected async uploadBatch(filePath: string): Promise<boolean> {
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
          'User-Agent': this.userAgent!,
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
