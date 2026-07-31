import { generateUUID, tryJsonParse } from '@datadog/browser-core';
import { isIndexableObject } from '@datadog/js-core/util';
import { CreationReason, type SegmentMetadata } from '../../../domain/replay';
import { display } from '../../../tools/display';
import { hasNonEmptyStringId, isFiniteNumber, isNonNegativeInteger } from '../../../tools/validation';
import { BatchConsumer } from '../BatchConsumer';

declare const __SDK_VERSION__: string;

type ReplayBatchMetadata = SegmentMetadata & {
  raw_segment_size: number;
  compressed_segment_size: number;
};

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
    const parsedMetadata = tryJsonParse(lines[0]);
    if (parsedMetadata === undefined) {
      display.warn('Dropping malformed replay batch: metadata line is not valid JSON');
      return null;
    }

    if (!isValidReplayBatchMetadata(parsedMetadata)) {
      display.warn('Dropping malformed replay batch: metadata fields are missing or invalid');
      return null;
    }

    const metadataWithSizes = parsedMetadata;
    const sessionId = metadataWithSizes.session.id;
    const start = metadataWithSizes.start;
    const compressed = Buffer.from(lines[1], 'base64');

    // A crash can also leave a complete metadata line but a truncated base64 body. Uploading the
    // partial bytes yields an invalid zlib blob the intake rejects, so the corrupt file would be
    // retried every cycle. Validate the decoded length against the size the producer recorded and
    // drop the file when it doesn't match, matching the malformed-metadata handling above.
    const expectedSize = metadataWithSizes.compressed_segment_size;
    if (compressed.length !== expectedSize) {
      display.warn('Dropping malformed replay batch: segment body is truncated or incomplete');
      return null;
    }

    const formData = new FormData();
    formData.append('segment', new Blob([compressed], { type: 'application/octet-stream' }), `${sessionId}-${start}`);
    formData.append('event', new Blob([JSON.stringify(metadataWithSizes)], { type: 'application/json' }));

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

function isValidReplayBatchMetadata(value: unknown): value is ReplayBatchMetadata {
  if (!isIndexableObject(value)) {
    return false;
  }

  return (
    hasNonEmptyStringId(value.application) &&
    hasNonEmptyStringId(value.session) &&
    hasNonEmptyStringId(value.view) &&
    isFiniteNumber(value.start) &&
    isFiniteNumber(value.end) &&
    isNonNegativeInteger(value.records_count) &&
    typeof value.has_full_snapshot === 'boolean' &&
    isNonNegativeInteger(value.index_in_view) &&
    value.source === 'browser' &&
    isCreationReason(value.creation_reason) &&
    isNonNegativeInteger(value.raw_segment_size) &&
    isNonNegativeInteger(value.compressed_segment_size)
  );
}

function isCreationReason(value: unknown): value is CreationReason {
  return Object.values(CreationReason).some((reason) => reason === value);
}
