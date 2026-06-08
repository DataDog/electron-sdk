import { BatchConsumer } from '../BatchConsumer';

/**
 * Concrete {@link BatchConsumer} for standard JSON event tracks (RUM, logs, etc.).
 *
 * Assembles parsed events into a JSON array and POSTs it to the Datadog intake.
 * Uses server-side SDK conventions: `DD-API-KEY` as a request header and a
 * JSON array body. This is intentionally different from {@link ReplayBatchConsumer}
 * which uses browser SDK conventions (query-param auth, multipart body) because
 * the replay intake has different expectations from the RUM/logs/spans intakes.
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
        'User-Agent': this.userAgent!,
      },
      body: JSON.stringify(events),
    });
  }
}
