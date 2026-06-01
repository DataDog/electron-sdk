import zlib from 'node:zlib';

// ZLIB header for default compression (CMF=0x78, FLG=0x9C).
// Prepended to continuation segments (index > 0) which don't have a header
// emitted by zlib.createDeflate() since the stream is already started.
const ZLIB_HEADER = Buffer.from([0x78, 0x9c]);

// DEFLATE final empty block: BFINAL=1, BTYPE=01 (fixed Huffman), EOB symbol (256).
// This matches the [3, 0] bytes produced by Pako's `vt()` function.
const DEFLATE_FINAL_BLOCK = Buffer.from([0x03, 0x00]);

const ADLER_MOD = 65521;

/**
 * Maintains a single continuous ZLIB-compressed stream across multiple segment
 * flushes within a session, producing output byte-for-byte compatible with what
 * the browser SDK's Pako-based encoder generates.
 *
 * Each segment's compressed output matches the Pako worker's `write` + `vt()`
 * output format:
 *
 * - **Header**: ZLIB header bytes (0x78 0x9C). Only emitted by zlib.createDeflate()
 * for segment 0; manually prepended for segments 1..N.
 * - **Body**: Z_FULL_FLUSH compressed data — the LZ77 dictionary is reset after
 * each flush so every segment is independently decompressable. The backend
 * validates each segment with a standalone inflate before stitching.
 * - **Trailer**: [0x03, 0x00] (DEFLATE final empty block, BFINAL=1) followed by
 * a 4-byte big-endian Adler-32 checksum over ALL raw data compressed so far
 * (cumulative, not per-segment). This is exactly what Pako's `vt()` returns.
 *
 * The Datadog backend's stitching algorithm strips the 2-byte ZLIB header and
 * 6-byte trailer from every segment, concatenates the raw DEFLATE bodies, then
 * wraps the result with segment 0's header and the last segment's trailer —
 * producing a single valid ZLIB stream for the replay player.
 */
export class StreamingDeflate {
  private stream = zlib.createDeflate();
  private isFirstSegment = true;
  // Running Adler-32 state (initial: A=1, B=0 per RFC 1950)
  private adlerA = 1;
  private adlerB = 0;
  // Serialize concurrent calls so data events don't interleave.
  private queue: Promise<void> = Promise.resolve();

  compressSegment(data: Buffer): Promise<Buffer> {
    const result = this.queue.then(() => this.doCompress(data));
    this.queue = result.catch(() => undefined) as Promise<void>;
    return result;
  }

  private doCompress(data: Buffer): Promise<Buffer> {
    // Update running Adler-32 over the raw (uncompressed) data before compressing.
    this.updateAdler32(data);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      const onData = (chunk: Buffer) => chunks.push(chunk);
      // eslint-disable-next-line prefer-const
      let onError: (err: Error) => void;

      // Cleans up all attached event listeners to prevent memory leaks.
      const cleanup = () => {
        this.stream.off('data', onData);
        if (onError) this.stream.off('error', onError);
      };

      onError = (err) => {
        cleanup();
        reject(err);
      };

      this.stream.on('data', onData);
      this.stream.once('error', onError);

      this.stream.write(data);
      this.stream.flush(zlib.constants.Z_FULL_FLUSH, () => {
        cleanup();

        const parts: Buffer[] = [];

        if (!this.isFirstSegment) {
          // Segment 0 already has the ZLIB header from zlib.createDeflate().
          // Segments 1..N are continuations with no header — prepend one so
          // the backend's header-stripping doesn't corrupt actual deflate data.
          parts.push(ZLIB_HEADER);
        }
        this.isFirstSegment = false;

        parts.push(Buffer.concat(chunks));

        // Append the Pako-compatible trailer: DEFLATE final empty block +
        // 4-byte big-endian Adler-32 of all raw data compressed so far.
        parts.push(DEFLATE_FINAL_BLOCK);
        parts.push(this.adler32ToBuffer());

        resolve(Buffer.concat(parts));
      });
    });
  }

  private updateAdler32(data: Buffer): void {
    let a = this.adlerA;
    let b = this.adlerB;
    const len = data.length;
    let i = 0;

    // Process in block sizes up to 5000 bytes to safely accumulate sums
    // without modulo operations on every byte, preventing integer overflow.
    while (i < len) {
      const blockEnd = Math.min(i + 5000, len);
      for (; i < blockEnd; i++) {
        a += data[i];
        b += a;
      }
      a %= ADLER_MOD;
      b %= ADLER_MOD;
    }

    this.adlerA = a;
    this.adlerB = b;
  }

  private adler32ToBuffer(): Buffer {
    // Combine 'b' and 'a' into a single 32-bit signed integer.
    const value = (this.adlerB << 16) | this.adlerA | 0;

    // Fast-allocate 4 unmanaged bytes and write the value in Big-Endian order.
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32BE(value >>> 0, 0);
    return buf;
  }
}
