import zlib from 'node:zlib';
import { generateUUID } from '@datadog/browser-core';
import { display } from '../../../tools/display';
import { BatchConsumer } from '../BatchConsumer';

/**
 * Concrete {@link BatchConsumer} for the profiling track.
 *
 * Each `.log` file holds a single profile as two JSON lines (`event`, `trace`). The trace is
 * deflate-compressed and sent as a multipart `FormData` body alongside the raw event. Requests
 * carry the standard SDK headers: `DD-API-KEY`, `DD-EVP-ORIGIN` (`electron`),
 * `DD-EVP-ORIGIN-VERSION` (injected as `__SDK_VERSION__` at build time), and a fresh
 * `DD-REQUEST-ID` UUID per upload.
 *
 * File I/O, sending, and deletion on success are handled by {@link BatchConsumer}.
 */
export class ProfileBatchConsumer extends BatchConsumer {
  protected async buildRequest(lines: string[]): Promise<Request | null> {
    if (lines.length < 2) {
      // A profile file that isn't the expected two lines is corrupt or truncated on disk
      // (environment issue we cannot recover from): surface to the customer and drop it.
      display.warn('Dropping malformed profile: expected event and trace lines');
      return null;
    }

    const [eventJson, traceJson] = lines;

    // A crash mid-write can leave a recovered `.log` with two non-empty but truncated JSON lines.
    // Validate both parse before uploading; otherwise intake rejects the payload and the file is
    // retried on every cycle forever. Drop it instead.
    if (!isValidJson(eventJson) || !isValidJson(traceJson)) {
      display.warn('Dropping malformed profile: event or trace is not valid JSON');
      return null;
    }

    let compressed: Buffer;
    try {
      compressed = await deflate(Buffer.from(traceJson));
    } catch (error) {
      // Compression of a valid buffer effectively never fails; if it does it is unrecoverable,
      // so surface to the customer and drop rather than retrying the same input forever.
      display.warn('Dropping profile: failed to compress trace', error);
      return null;
    }

    const formData = new FormData();
    formData.append('event', new Blob([eventJson], { type: 'application/json' }), 'event.json');
    formData.append('wall-time.json', new Blob([new Uint8Array(compressed)]), 'wall-time.json');

    return new Request(this.intakeUrl, {
      method: 'POST',
      headers: {
        'DD-API-KEY': this.clientToken,
        'DD-EVP-ORIGIN': 'electron',
        'DD-EVP-ORIGIN-VERSION': __SDK_VERSION__,
        'DD-REQUEST-ID': generateUUID(),
        'User-Agent': this.userAgent!,
      },
      body: formData,
    });
  }
}

function isValidJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function deflate(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.deflate(data, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}
