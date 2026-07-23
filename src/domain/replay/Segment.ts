/**
 * Buffers BrowserRecord objects into a segment, tracking metadata required
 * by the session-replay intake (timestamps, record count, full snapshot flag).
 *
 * On flush, produces the complete segment JSON (records array + metadata)
 * and the metadata object separately (for the multipart 'event' part).
 */

export interface SegmentContext {
  application: { id: string };
  session: { id: string };
  view: { id: string };
}

export const CreationReason = {
  INIT: 'init',
  SEGMENT_DURATION_LIMIT: 'segment_duration_limit',
  SEGMENT_BYTES_LIMIT: 'segment_bytes_limit',
  VIEW_CHANGE: 'view_change',
  BEFORE_UNLOAD: 'before_unload',
  VISIBILITY_HIDDEN: 'visibility_hidden',
  PAGE_FROZEN: 'page_frozen',
} as const;

export type CreationReason = (typeof CreationReason)[keyof typeof CreationReason];

/** Record type constants from the browser SDK's rrweb-based recording (RecordType). */
const FULL_SNAPSHOT_TYPE = 2;
// Browser SDK 7.x change-format: the initial snapshot of a view arrives as a Change record
// (type 12) rather than a legacy full-snapshot record. It only counts as the full snapshot on
// the first segment of the view (index_in_view === 0).
const CHANGE_TYPE = 12;

export interface SegmentMetadata {
  application: { id: string };
  session: { id: string };
  view: { id: string };
  start: number;
  end: number;
  records_count: number;
  has_full_snapshot: boolean;
  index_in_view: number;
  source: 'browser';
  creation_reason: CreationReason;
}

export interface SegmentFlushResult {
  /** Complete segment JSON (records + metadata), ready for compression. */
  serializedSegment: string;
  /** Metadata for the multipart 'event' part. */
  metadata: SegmentMetadata;
  /** Byte size of the serialized segment before compression. */
  rawBytesCount: number;
}

/**
 * The payload written to disk and read by {@link ReplayBatchConsumer}.
 * Produced by {@link ReplayCollection} after compression.
 */
export interface ReplaySegmentPayload {
  metadata: SegmentMetadata;
  rawBytesCount: number;
  compressed: Buffer;
}

export interface BrowserRecord {
  type: number;
  timestamp: number;
  [key: string]: unknown;
}

/** UTF-8 byte size a record contributes to a segment (matches Segment's own accounting). */
export function byteSizeOf(record: BrowserRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

export class Segment {
  private records: BrowserRecord[] = [];
  private metadata: SegmentMetadata;
  private _estimatedSize = 0;

  constructor(context: SegmentContext, creationReason: CreationReason, indexInView: number) {
    this.metadata = {
      ...context,
      start: Infinity,
      end: -Infinity,
      records_count: 0,
      has_full_snapshot: false,
      index_in_view: indexInView,
      source: 'browser',
      creation_reason: creationReason,
    };
  }

  get recordsCount(): number {
    return this.records.length;
  }

  get isEmpty(): boolean {
    return this.records.length === 0;
  }

  get estimatedSize(): number {
    return this._estimatedSize;
  }

  addRecord(record: BrowserRecord, recordByteSize: number = byteSizeOf(record)): void {
    // Measure UTF-8 byte length, not UTF-16 code-unit count: SEGMENT_BYTES_LIMIT is a byte
    // cap and flush() reports rawBytesCount via Buffer.byteLength. Using String#length would
    // undercount non-ASCII DOM text (CJK/emoji), letting a segment exceed the intended cap.
    // The caller may pass a precomputed size (from byteSizeOf) to avoid stringifying twice.
    this._estimatedSize += recordByteSize;
    this.records.push(record);
    this.metadata.start = Math.min(this.metadata.start, record.timestamp);
    this.metadata.end = Math.max(this.metadata.end, record.timestamp);
    this.metadata.records_count += 1;
    // Mirror the browser SDK's segment.js: a full snapshot is a legacy type-2 record, or — in the
    // 7.x change format — a Change record (type 12) on the view's first segment (index_in_view 0).
    if (record.type === FULL_SNAPSHOT_TYPE || (record.type === CHANGE_TYPE && this.metadata.index_in_view === 0)) {
      this.metadata.has_full_snapshot = true;
    }
  }

  flush(): SegmentFlushResult {
    // Match the browser SDK's exact wire format (from segment.js in @datadog/browser-rum):
    //   encoder.write('{"records":[' + JSON.stringify(r1))   ← opening + first record
    //   encoder.write(',' + JSON.stringify(rN))              ← subsequent records
    //   encoder.write(`],${JSON.stringify(metadata).slice(1)}\n`)  ← close + metadata + newline
    //
    // The resulting format is: {"records":[r1,...,rN],...metadata}\n
    //
    // The trailing \n is critical: the backend stitches segments by concatenating
    // DEFLATE bodies. The decompressed stitched stream is N lines of NDJSON that
    // the player splits on \n to extract individual segment payloads. Without \n
    // the player sees one large blob and can only parse segment 0.
    const metadataJson = JSON.stringify(this.metadata);
    // metadataJson = '{"start":...}' — drop the opening '{' to splice into the records object
    const serializedSegment = `{"records":${JSON.stringify(this.records)},${metadataJson.slice(1)}\n`;

    return {
      serializedSegment,
      metadata: { ...this.metadata },
      rawBytesCount: Buffer.byteLength(serializedSegment, 'utf8'),
    };
  }
}
