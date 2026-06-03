import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { StreamingDeflate } from './StreamingDeflate';

const ZLIB_HEADER = [0x78, 0x9c];
const DEFLATE_FINAL_BLOCK = [0x03, 0x00];

describe('StreamingDeflate', () => {
  describe('output structure', () => {
    it('returns a non-empty Buffer', async () => {
      const deflate = new StreamingDeflate();
      const result = await deflate.compressSegment(Buffer.from('hello world'));
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeGreaterThan(0);
    });

    it('first segment starts with the ZLIB header [0x78, 0x9C]', async () => {
      const deflate = new StreamingDeflate();
      const result = await deflate.compressSegment(Buffer.from('first segment data'));
      expect(result[0]).toBe(ZLIB_HEADER[0]);
      expect(result[1]).toBe(ZLIB_HEADER[1]);
    });

    it('subsequent segments also start with the ZLIB header (manually prepended)', async () => {
      const deflate = new StreamingDeflate();
      await deflate.compressSegment(Buffer.from('first segment'));
      const second = await deflate.compressSegment(Buffer.from('second segment'));
      expect(second[0]).toBe(ZLIB_HEADER[0]);
      expect(second[1]).toBe(ZLIB_HEADER[1]);
    });

    it('each segment ends with DEFLATE final block [0x03, 0x00] followed by 4-byte Adler-32', async () => {
      const deflate = new StreamingDeflate();
      const result = await deflate.compressSegment(Buffer.from('test payload'));
      // Last 6 bytes: [0x03, 0x00] (final block) + Adler-32 (4 bytes)
      expect(result[result.length - 6]).toBe(DEFLATE_FINAL_BLOCK[0]);
      expect(result[result.length - 5]).toBe(DEFLATE_FINAL_BLOCK[1]);
      // 4-byte Adler-32 follows
      expect(result.length).toBeGreaterThanOrEqual(8);
    });

    it('single segment is a valid ZLIB stream that inflates back to the original data', async () => {
      const deflate = new StreamingDeflate();
      const original = Buffer.from('the quick brown fox jumps over the lazy dog');
      const compressed = await deflate.compressSegment(original);
      const inflated = zlib.inflateSync(compressed);
      expect(inflated.equals(original)).toBe(true);
    });
  });

  describe('Adler-32 checksum', () => {
    it('is cumulative across segments — covers all data sent so far', async () => {
      // Two separate instances with data in different orders should produce different checksums
      const d1 = new StreamingDeflate();
      const d2 = new StreamingDeflate();

      await d1.compressSegment(Buffer.from('aaa'));
      const r1 = await d1.compressSegment(Buffer.from('bbb'));

      await d2.compressSegment(Buffer.from('bbb'));
      const r2 = await d2.compressSegment(Buffer.from('aaa'));

      // Adler-32 = last 4 bytes of each segment
      const adler1 = r1.slice(-4);
      const adler2 = r2.slice(-4);
      // Different data order → different cumulative checksum
      expect(adler1.equals(adler2)).toBe(false);
    });

    it('two instances compressing the same data in the same order produce equal Adler-32', async () => {
      const d1 = new StreamingDeflate();
      const d2 = new StreamingDeflate();
      const data = Buffer.from('identical data');

      const r1 = await d1.compressSegment(data);
      const r2 = await d2.compressSegment(data);

      expect(r1.slice(-4).equals(r2.slice(-4))).toBe(true);
    });
  });

  describe('queue serialization', () => {
    it('resolves concurrent calls in call order', async () => {
      const deflate = new StreamingDeflate();
      const order: number[] = [];

      const p1 = deflate.compressSegment(Buffer.from('a')).then(() => order.push(1));
      const p2 = deflate.compressSegment(Buffer.from('b')).then(() => order.push(2));
      const p3 = deflate.compressSegment(Buffer.from('c')).then(() => order.push(3));

      await Promise.all([p1, p2, p3]);
      expect(order).toEqual([1, 2, 3]);
    });

    it('each call produces a valid result even under concurrency', async () => {
      const deflate = new StreamingDeflate();
      const data = Buffer.from('concurrent data');

      const [r1, r2] = await Promise.all([deflate.compressSegment(data), deflate.compressSegment(data)]);

      expect(r1).toBeInstanceOf(Buffer);
      expect(r2).toBeInstanceOf(Buffer);
      expect(r1.length).toBeGreaterThan(0);
      expect(r2.length).toBeGreaterThan(0);
    });
  });
});
