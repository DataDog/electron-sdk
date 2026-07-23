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

// Mirrors computeIntakeUrlForTrack output: the standard track query is already present, so the
// consumer must merge its params in rather than appending a second `?`.
const config = {
  trackPath: '/mock/replay',
  intakeUrl: 'https://browser-intake-datadoghq.com/api/v2/replay?ddsource=electron',
  clientToken: 'test-client-token',
};

function makeFileLine(metadata: Record<string, unknown>, compressed: Buffer): string {
  return `${JSON.stringify(metadata)}\n${compressed.toString('base64')}\n`;
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
    it('includes the correct query parameters', async () => {
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      const url = new URL(request.url);
      // ddsource=electron from the track query is overwritten with the browser value, not duplicated.
      expect(url.searchParams.getAll('ddsource')).toEqual(['browser']);
      expect(url.searchParams.get('dd-api-key')).toBe(config.clientToken);
      expect(url.searchParams.get('dd-evp-origin')).toBe('browser');
      expect(url.searchParams.get('dd-request-id')).toBe('test-request-id');
      expect(url.searchParams.get('ddtags')).toContain('sdk_version:0.0.0-test');
    });

    it('does not produce a double question mark when the intake URL already has a query', async () => {
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      expect(request.url.match(/\?/g)).toHaveLength(1);
    });

    it('merges params inside ddforward when the intake URL is a proxy', async () => {
      const proxyConsumer = new ReplayBatchConsumer({
        ...config,
        intakeUrl: 'https://proxy.example.com/?ddforward=%2Fapi%2Fv2%2Freplay%3Fddsource%3Delectron',
      });
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );

      await proxyConsumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      const url = new URL(request.url);
      // Auth/metadata params must live on the forwarded path, not the proxy URL itself.
      expect(url.searchParams.get('dd-api-key')).toBeNull();
      const forwarded = new URL(url.searchParams.get('ddforward')!, 'https://placeholder.invalid');
      expect(forwarded.pathname).toBe('/api/v2/replay');
      expect(forwarded.searchParams.getAll('ddsource')).toEqual(['browser']);
      expect(forwarded.searchParams.get('dd-api-key')).toBe(config.clientToken);
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

    it('drops a file missing session.id or start', async () => {
      fsMocks.readdir.mockResolvedValue(['corrupt.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine({ start: 0 }, Buffer.from([0x01])));

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledWith('/mock/replay/corrupt.log');
    });

    it('drops a file whose segment body is truncated (shorter than compressed_segment_size)', async () => {
      fsMocks.readdir.mockResolvedValue(['corrupt.log']);
      // Valid metadata claiming 50 compressed bytes, but only 2 bytes of body survived the crash.
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 100, compressed_segment_size: 50 },
          Buffer.from([0x78, 0x9c])
        )
      );

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledWith('/mock/replay/corrupt.log');
    });
  });

  describe('request headers and body', () => {
    it('sends the User-Agent header', async () => {
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(
        makeFileLine(
          { session: { id: 'sess' }, start: 0, raw_segment_size: 1, compressed_segment_size: 1 },
          Buffer.from([0x01])
        )
      );

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      expect(request.headers.get('User-Agent')).toBe(TEST_USER_AGENT);
    });

    it('sends a multipart/form-data body', async () => {
      const metadata = { session: { id: 'sess-1' }, start: 1000, raw_segment_size: 100, compressed_segment_size: 2 };
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine(metadata, Buffer.from([0x78, 0x9c])));

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      // FormData serialises to a ReadableStream in Request; verify via Content-Type
      expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    });
  });
});
