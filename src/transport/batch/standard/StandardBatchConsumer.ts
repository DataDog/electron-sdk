import { generateUUID } from '@datadog/browser-core';
import { BatchConsumer } from '../BatchConsumer';

/**
 * Concrete {@link BatchConsumer} for standard JSON event tracks (RUM, spans, etc.).
 *
 * Assembles parsed events into a JSON array and POSTs it to the Datadog intake.
 * Each request carries the standard SDK headers: `DD-API-KEY`, `DD-EVP-ORIGIN` (`electron`),
 * `DD-EVP-ORIGIN-VERSION` (injected as `__SDK_VERSION__` at build time), and a fresh
 * `DD-REQUEST-ID` UUID per upload.
 *
 * File I/O, sending, and deletion on success are handled by {@link BatchConsumer}.
 */
export class StandardBatchConsumer extends BatchConsumer {
  protected buildRequest(lines: string[]): Request | null {
    if (lines.length === 0) {
      return null;
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

    return new Request(this.intakeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': this.clientToken,
        'DD-EVP-ORIGIN': 'electron',
        'DD-EVP-ORIGIN-VERSION': __SDK_VERSION__,
        'DD-REQUEST-ID': generateUUID(),
        'User-Agent': this.userAgent!,
      },
      body: JSON.stringify(events),
    });
  }
}
