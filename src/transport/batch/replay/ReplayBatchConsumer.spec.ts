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

describe('ReplayBatchConsumer — request construction', () => {
  let consumer: ReplayBatchConsumer;

  beforeEach(() => {
    fsMocks.reset();
    vi.mocked(getUserAgent).mockReset().mockReturnValue(TEST_USER_AGENT);
    consumer = new ReplayBatchConsumer(config);
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
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
      expect(url.searchParams.get('ddsource')).toBe('browser');
      expect(url.searchParams.get('dd-api-key')).toBe(config.clientToken);
      expect(url.searchParams.get('dd-evp-origin')).toBe('browser');
      expect(url.searchParams.get('dd-request-id')).toBe('test-request-id');
      expect(url.searchParams.get('ddtags')).toContain('sdk_version:0.0.0-test');
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
      const metadata = { session: { id: 'sess-1' }, start: 1000, raw_segment_size: 100, compressed_segment_size: 50 };
      fsMocks.readdir.mockResolvedValue(['segment.log']);
      fsMocks.readFile.mockResolvedValue(makeFileLine(metadata, Buffer.from([0x78, 0x9c])));

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      // FormData serialises to a ReadableStream in Request; verify via Content-Type
      expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    });
  });
});
