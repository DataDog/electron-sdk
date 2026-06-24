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
    it('includes the User-Agent and DD-API-KEY headers', async () => {
      fsMocks.readdir.mockResolvedValue(['test.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      expect(request.headers.get('User-Agent')).toBe(TEST_USER_AGENT);
      expect(request.headers.get('DD-API-KEY')).toBe(config.clientToken);
      expect(request.headers.get('Content-Type')).toBe('application/json');
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
  });
});
