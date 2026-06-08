import { generateUUID } from '@datadog/browser-core';
import { BatchConsumer } from '../BatchConsumer';

declare const __SDK_VERSION__: string;

/**
 * Concrete {@link BatchConsumer} for session replay segments.
 *
 * Reads the two-line format written by {@link ReplayBatchProducer} and builds a
 * multipart/form-data POST to the Datadog session replay intake:
 *   - `segment`: deflate-compressed binary blob
 *   - `event`: JSON metadata including raw/compressed size fields
 *
 * File I/O, sending, and deletion on success are handled by {@link BatchConsumer}.
 */
export class ReplayBatchConsumer extends BatchConsumer {
  protected buildRequest(lines: string[]): Request | null {
    if (lines.length < 2) {
      return null;
    }

    const metadataWithSizes = JSON.parse(lines[0]) as Record<string, unknown>;
    const compressed = Buffer.from(lines[1], 'base64');

    const sessionId = (metadataWithSizes.session as { id: string }).id;
    const start = metadataWithSizes.start as number;

    const formData = new FormData();
    formData.append('segment', new Blob([compressed], { type: 'application/octet-stream' }), `${sessionId}-${start}`);
    formData.append('event', new Blob([JSON.stringify(metadataWithSizes)], { type: 'application/json' }));

    // The replay intake uses browser SDK conventions: auth and metadata as URL
    // query params, not headers. ddsource and dd-evp-origin are 'browser' because
    // the records originate from @datadog/browser-rum in the renderer — the backend
    // uses these values to determine how to parse and stitch the compressed segments.
    const params = new URLSearchParams({
      ddsource: 'browser',
      ddtags: `sdk_version:${__SDK_VERSION__}`,
      'dd-api-key': this.clientToken,
      'dd-evp-origin': 'browser',
      'dd-evp-origin-version': __SDK_VERSION__,
      'dd-request-id': generateUUID(),
    });

    return new Request(`${this.intakeUrl}?${params.toString()}`, {
      method: 'POST',
      headers: { 'User-Agent': this.userAgent! },
      body: formData,
    });
  }
}
