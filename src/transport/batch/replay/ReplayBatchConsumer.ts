import { generateUUID } from '@datadog/browser-core';
import { display } from '../../../tools/display';
import { BatchConsumer } from '../BatchConsumer';
import { appendIntakeParams } from '../../utils';

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

    // A crash mid-write can leave a recovered `.log` with a truncated metadata line. An unguarded
    // JSON.parse would throw here — before the base class reaches its fetch error handling or deletes
    // the file — aborting the whole upload cycle and blocking every later replay batch on retry.
    // Validate and drop instead, matching ProfileBatchConsumer.
    let metadataWithSizes: Record<string, unknown>;
    try {
      metadataWithSizes = JSON.parse(lines[0]) as Record<string, unknown>;
    } catch {
      display.warn('Dropping malformed replay batch: metadata line is not valid JSON');
      return null;
    }

    const session = metadataWithSizes.session as { id?: unknown } | undefined;
    const sessionId = session?.id;
    const start = metadataWithSizes.start;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof start !== 'number') {
      display.warn('Dropping malformed replay batch: missing session.id or start');
      return null;
    }

    const compressed = Buffer.from(lines[1], 'base64');

    // A crash can also leave a complete metadata line but a truncated base64 body. Uploading the
    // partial bytes yields an invalid zlib blob the intake rejects, so the corrupt file would be
    // retried every cycle. Validate the decoded length against the size the producer recorded and
    // drop the file when it doesn't match, matching the malformed-metadata handling above.
    const expectedSize = metadataWithSizes.compressed_segment_size;
    if (typeof expectedSize !== 'number' || compressed.length !== expectedSize) {
      display.warn('Dropping malformed replay batch: segment body is truncated or incomplete');
      return null;
    }

    const formData = new FormData();
    formData.append('segment', new Blob([compressed], { type: 'application/octet-stream' }), `${sessionId}-${start}`);
    formData.append('event', new Blob([JSON.stringify(metadataWithSizes)], { type: 'application/json' }));

    // The replay intake uses browser SDK conventions: auth and metadata as URL
    // query params, not headers. ddsource and dd-evp-origin are 'browser' because
    // the records originate from @datadog/browser-rum in the renderer — the backend
    // uses these values to determine how to parse and stitch the compressed segments.
    //
    // intakeUrl already carries the standard track query (`?ddsource=electron`, or a proxy
    // `?ddforward=...`), so merge these params in — overwriting ddsource — rather than appending
    // a second `?`, which would otherwise corrupt ddsource and proxy forwarding.
    const url = appendIntakeParams(this.intakeUrl, {
      ddsource: 'browser',
      ddtags: `sdk_version:${__SDK_VERSION__}`,
      'dd-api-key': this.clientToken,
      'dd-evp-origin': 'browser',
      'dd-evp-origin-version': __SDK_VERSION__,
      'dd-request-id': generateUUID(),
    });

    return new Request(url, {
      method: 'POST',
      headers: { 'User-Agent': this.userAgent! },
      body: formData,
    });
  }
}
