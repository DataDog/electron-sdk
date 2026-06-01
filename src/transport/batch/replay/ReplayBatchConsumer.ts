import fs from 'node:fs/promises';
import { generateUUID } from '@datadog/browser-core';
import { BatchConsumer } from '../BatchConsumer';

declare const __SDK_VERSION__: string;

/**
 * Concrete {@link BatchConsumer} for session replay segments.
 *
 * Reads the two-line format written by {@link ReplayBatchProducer} and sends
 * a multipart/form-data POST to the Datadog session replay intake:
 *   - `segment`: deflate-compressed binary blob
 *   - `event`: JSON metadata including raw/compressed size fields
 */
export class ReplayBatchConsumer extends BatchConsumer {
  protected async uploadBatch(filePath: string): Promise<boolean> {
    const lines = await this.readBatchFile(filePath);

    if (lines.length < 2) {
      await fs.unlink(filePath).catch(() => undefined);
      return true;
    }

    const metadataWithSizes = JSON.parse(lines[0]) as Record<string, unknown>;
    const compressed = Buffer.from(lines[1], 'base64');

    const sessionId = (metadataWithSizes.session as { id: string }).id;
    const start = metadataWithSizes.start as number;

    const formData = new FormData();
    formData.append('segment', new Blob([compressed], { type: 'application/octet-stream' }), `${sessionId}-${start}`);
    formData.append('event', new Blob([JSON.stringify(metadataWithSizes)], { type: 'application/json' }));

    const params = new URLSearchParams({
      ddsource: 'browser',
      ddtags: `sdk_version:${__SDK_VERSION__}`,
      'dd-api-key': this.clientToken,
      'dd-evp-origin': 'browser',
      'dd-evp-origin-version': __SDK_VERSION__,
      'dd-request-id': generateUUID(),
    });

    try {
      const response = await fetch(`${this.intakeUrl}?${params.toString()}`, {
        method: 'POST',
        headers: { 'User-Agent': this.userAgent! },
        body: formData,
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
