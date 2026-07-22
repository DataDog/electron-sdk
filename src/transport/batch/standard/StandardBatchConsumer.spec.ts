import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StandardBatchConsumer } from './StandardBatchConsumer';
import type { BatchConsumerConfig } from '../BatchConsumer';
import path from 'node:path';
import { getUserAgent } from '../../userAgent';
import { mockFs } from '../../../mocks.specUtil';

vi.mock('node:fs/promises');
vi.mock('../../userAgent');
const fsMocks = mockFs();

const TEST_USER_AGENT = 'TestApp/1.0.0 (test) Electron/0 Chrome/0 Node/0';

const config: BatchConsumerConfig = {
  trackPath: 'rum',
  intakeUrl: 'https://intake.datadoghq.com/api/v2/rum',
  clientToken: 'test-client-token',
};

describe('StandardBatchConsumer — request construction', () => {
  let consumer: StandardBatchConsumer;

  beforeEach(() => {
    fsMocks.reset();
    vi.mocked(getUserAgent).mockReset().mockReturnValue(TEST_USER_AGENT);
    consumer = new StandardBatchConsumer(config);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.unlink.mockResolvedValue(undefined);
  });

  describe('request headers', () => {
    let request: Request;

    beforeEach(async () => {
      fsMocks.readdir.mockResolvedValue(['test.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');
      await consumer.upload();
      [request] = vi.mocked(fetch).mock.calls[0] as [Request];
    });

    it.each([
      { header: 'Content-Type', expected: 'application/json' },
      { header: 'DD-API-KEY', expected: config.clientToken },
      { header: 'DD-EVP-ORIGIN', expected: 'electron' },
      { header: 'DD-EVP-ORIGIN-VERSION', expected: 'test' },
      { header: 'User-Agent', expected: TEST_USER_AGENT },
    ])('includes $header header', ({ header, expected }) => {
      expect(request.headers.get(header)).toEqual(expected);
    });

    it('includes a DD-REQUEST-ID header with a UUID format', () => {
      expect(request.headers.get('DD-REQUEST-ID')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('generates a fresh DD-REQUEST-ID for each request', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');
      vi.mocked(fetch).mockClear();

      await consumer.upload();

      const [req1, req2] = vi.mocked(fetch).mock.calls.map(([r]) => r as Request);
      const id1 = req1.headers.get('DD-REQUEST-ID');
      const id2 = req2.headers.get('DD-REQUEST-ID');
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });
  });

  describe('request URL and body', () => {
    it('posts to the configured intakeUrl', async () => {
      fsMocks.readdir.mockResolvedValue(['test.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      expect(request.url).toBe(config.intakeUrl);
    });

    it('sends only .log files and ignores others', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.tmp']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      await consumer.upload();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fsMocks.readFile).toHaveBeenCalledWith(path.join(config.trackPath, 'a.log'), 'utf8');
    });

    it('assembles a JSON array body from valid lines', async () => {
      fsMocks.readdir.mockResolvedValue(['test.log']);
      const rawContent = ['{"valid": 1}', 'invalid-json', '{"valid": 2}'].join('\n');
      fsMocks.readFile.mockResolvedValue(rawContent);

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      const body = (await request.json()) as unknown[];
      expect(body).toEqual([{ valid: 1 }, { valid: 2 }]);
    });

    it('processes multiple log files in alphabetical order', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log', 'c.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      await consumer.upload();

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fsMocks.readFile).toHaveBeenNthCalledWith(1, path.join(config.trackPath, 'a.log'), 'utf8');
      expect(fsMocks.readFile).toHaveBeenNthCalledWith(3, path.join(config.trackPath, 'c.log'), 'utf8');
    });

    it('processes files by sequence numerically, not lexically, when timestamps tie', async () => {
      // Same ms, unpadded sequence: a lexical sort would upload seq 10 before seq 9.
      fsMocks.readdir.mockResolvedValue(['batch-100-10.log', 'batch-100-9.log', 'batch-100-1.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      await consumer.upload();

      expect(fsMocks.readFile).toHaveBeenNthCalledWith(1, path.join(config.trackPath, 'batch-100-1.log'), 'utf8');
      expect(fsMocks.readFile).toHaveBeenNthCalledWith(2, path.join(config.trackPath, 'batch-100-9.log'), 'utf8');
      expect(fsMocks.readFile).toHaveBeenNthCalledWith(3, path.join(config.trackPath, 'batch-100-10.log'), 'utf8');
    });
  });
});
