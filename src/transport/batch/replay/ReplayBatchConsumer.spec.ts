import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplayBatchConsumer } from './ReplayBatchConsumer';
import { getUserAgent } from '../../userAgent';
import { mockFs } from '../../../mocks.specUtil';

vi.mock('node:fs/promises');
vi.mock('../../userAgent');
vi.mock('@datadog/browser-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@datadog/browser-core')>()),
  generateUUID: vi.fn(() => 'test-request-id'),
}));
vi.stubGlobal('__SDK_VERSION__', '0.0.0-test');

const fsMocks = mockFs();
const TEST_USER_AGENT = 'TestApp/1.0.0 Electron/0';

const config = {
  trackPath: '/mock/replay',
  intakeUrl: 'https://browser-intake-datadoghq.com/api/v2/replay?ddsource=electron',
  clientToken: 'test-client-token',
};

function makeFileLine(metadata: Record<string, unknown>, compressed: Buffer): string {
  return `${JSON.stringify(metadata)}\n${compressed.toString('base64')}\n`;
}

function makeMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    application: { id: 'app' },
    session: { id: 'sess' },
    view: { id: 'view' },
    start: 0,
    end: 1,
    records_count: 1,
    has_full_snapshot: false,
    index_in_view: 0,
    source: 'browser',
    creation_reason: 'init',
    raw_segment_size: 1,
    compressed_segment_size: 1,
    ...overrides,
  };
}

describe('ReplayBatchConsumer — request construction', () => {
  let consumer: ReplayBatchConsumer;

  beforeEach(() => {
    fsMocks.reset();
    vi.mocked(getUserAgent).mockReset().mockReturnValue(TEST_USER_AGENT);
    consumer = new ReplayBatchConsumer(config);
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.unlink.mockResolvedValue(undefined);
  });

  describe('request URL', () => {
    it('uses the configured intake URL without adding replay-specific query parameters', async () => {
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine(makeMetadata(), Buffer.from([0x01])));

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      expect(request.url).toBe(config.intakeUrl);
    });

    it('uses the configured proxy URL unchanged', async () => {
      const proxyUrl = 'https://proxy.example.com/?ddforward=%2Fapi%2Fv2%2Freplay%3Fddsource%3Delectron';
      const proxyConsumer = new ReplayBatchConsumer({
        ...config,
        intakeUrl: proxyUrl,
      });
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine(makeMetadata(), Buffer.from([0x01])));

      await proxyConsumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      expect(request.url).toBe(proxyUrl);
    });
  });

  describe('malformed batch files', () => {
    it('drops (deletes without sending) a file whose metadata line is not valid JSON', async () => {
      fsMocks.readdir.mockResolvedValue(['corrupt.log']);
      // Truncated metadata line followed by a base64 line — the two-line shape is intact.
      fsMocks.readFile.mockResolvedValue(`{"session":{"id":"ses\n${Buffer.from([0x01]).toString('base64')}\n`);

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledWith('/mock/replay/corrupt.log');
    });

    it('drops a file with incomplete metadata', async () => {
      fsMocks.readdir.mockResolvedValue(['corrupt.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine({ start: 0 }, Buffer.from([0x01])));

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledWith('/mock/replay/corrupt.log');
    });

    it('drops a file with an invalid metadata field type', async () => {
      fsMocks.readdir.mockResolvedValue(['corrupt.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine(makeMetadata({ records_count: '1' }), Buffer.from([0x01])));

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledWith('/mock/replay/corrupt.log');
    });

    it('drops a file whose segment body is truncated (shorter than compressed_segment_size)', async () => {
      fsMocks.readdir.mockResolvedValue(['corrupt.log']);
      // Valid metadata claiming 50 compressed bytes, but only 2 bytes of body survived the crash.
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(makeMetadata({ raw_segment_size: 100, compressed_segment_size: 50 }), Buffer.from([0x78, 0x9c]))
      );

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledWith('/mock/replay/corrupt.log');
    });
  });

  describe('request headers and body', () => {
    it('sends the standard Electron transport headers', async () => {
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine(makeMetadata(), Buffer.from([0x01])));

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      expect(request.headers.get('DD-API-KEY')).toBe(config.clientToken);
      expect(request.headers.get('DD-EVP-ORIGIN')).toBe('electron');
      expect(request.headers.get('DD-EVP-ORIGIN-VERSION')).toBe('0.0.0-test');
      expect(request.headers.get('DD-REQUEST-ID')).toBe('test-request-id');
      expect(request.headers.get('User-Agent')).toBe(TEST_USER_AGENT);
    });

    it('sends a multipart/form-data body', async () => {
      const metadata = makeMetadata({
        session: { id: 'sess-1' },
        start: 1000,
        raw_segment_size: 100,
        compressed_segment_size: 2,
      });
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine(metadata, Buffer.from([0x78, 0x9c])));

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      // FormData serialises to a ReadableStream in Request; verify via Content-Type
      expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    });
  });
});
