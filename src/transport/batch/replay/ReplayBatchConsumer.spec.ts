import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplayBatchConsumer } from './ReplayBatchConsumer';
import { getUserAgent } from '../../userAgent';
import { mockFs } from '../../../mocks.specUtil';

vi.mock('node:fs/promises');
vi.mock('../../userAgent');
vi.mock('@datadog/browser-core', () => ({
  generateUUID: vi.fn(() => 'test-request-id'),
}));
vi.stubGlobal('__SDK_VERSION__', '0.0.0-test');

const fsMocks = mockFs();
const TEST_USER_AGENT = 'TestApp/1.0.0 Electron/0';

const config = {
  trackPath: '/mock/replay',
  intakeUrl: 'https://browser-intake-datadoghq.com/api/v2/replay',
  clientToken: 'test-client-token',
};

function makeFileLine(metadata: Record<string, unknown>, compressed: Buffer): string {
  return `${JSON.stringify(metadata)}\n${compressed.toString('base64')}\n`;
}

describe('ReplayBatchConsumer', () => {
  let consumer: ReplayBatchConsumer;

  beforeEach(() => {
    fsMocks.reset();
    vi.mocked(getUserAgent).mockReset().mockReturnValue(TEST_USER_AGENT);
    consumer = new ReplayBatchConsumer(config);
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.unlink.mockResolvedValue(undefined);
  });

  describe('upload lifecycle', () => {
    it('reads .log files from the track directory and uploads each one', async () => {
      const metadata = { session: { id: 'sess-1' }, start: 1000, raw_segment_size: 100, compressed_segment_size: 50 };
      const compressed = Buffer.from([0x78, 0x9c, 0x03, 0x00]);
      fsMocks.readdir.mockResolvedValue(['segment-1.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine(metadata, compressed));

      await consumer.upload();

      expect(fetch).toHaveBeenCalledOnce();
    });

    it('deletes the file after a successful upload', async () => {
      fsMocks.readdir.mockResolvedValue(['segment-1.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );

      await consumer.upload();

      expect(fsMocks.unlink).toHaveBeenCalledOnce();
    });

    it('keeps the file when the intake returns a non-ok response', async () => {
      fsMocks.readdir.mockResolvedValue(['segment-1.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

      await consumer.upload();

      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });

    it('keeps the file when fetch throws a network error', async () => {
      fsMocks.readdir.mockResolvedValue(['segment-1.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(consumer.upload()).resolves.not.toThrow();
      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });

    it('deletes an empty file (< 2 lines) without calling fetch', async () => {
      fsMocks.readdir.mockResolvedValue(['empty.log']);
      fsMocks.readFile.mockResolvedValue('');

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledOnce();
    });

    it('does not crash if trackPath does not exist', async () => {
      fsMocks.access.mockRejectedValue(new Error('ENOENT'));
      await expect(consumer.upload()).resolves.not.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('request format', () => {
    it('sends a multipart/form-data POST request', async () => {
      const metadata = { session: { id: 'sess-1' }, start: 1000, raw_segment_size: 100, compressed_segment_size: 50 };
      const compressed = Buffer.from([0x78, 0x9c]);
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine(metadata, compressed));

      await consumer.upload();

      const [, init] = vi.mocked(fetch).mock.calls[0];
      expect((init?.body as FormData) instanceof FormData).toBe(true);
    });

    it('includes the correct query parameters in the URL', async () => {
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );

      await consumer.upload();

      const [url] = vi.mocked(fetch).mock.calls[0];
      const parsedUrl = new URL(url as string);
      expect(parsedUrl.searchParams.get('ddsource')).toBe('browser');
      expect(parsedUrl.searchParams.get('dd-api-key')).toBe(config.clientToken);
      expect(parsedUrl.searchParams.get('dd-evp-origin')).toBe('browser');
      expect(parsedUrl.searchParams.get('dd-request-id')).toBe('test-request-id');
      expect(parsedUrl.searchParams.get('ddtags')).toContain('sdk_version:0.0.0-test');
    });

    it('sends the User-Agent header', async () => {
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );

      await consumer.upload();

      const [, init] = vi.mocked(fetch).mock.calls[0];
      expect((init?.headers as Record<string, string>)['User-Agent']).toBe(TEST_USER_AGENT);
    });

    it('calls getUserAgent only once across multiple uploads', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );

      await consumer.upload();
      await consumer.upload();

      expect(getUserAgent).toHaveBeenCalledTimes(1);
    });
  });
});
