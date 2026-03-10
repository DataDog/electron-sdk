import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BatchConsumer } from './BatchConsumer';
import type { ConsumerConfig } from './BatchConsumer';
import path from 'node:path';
import { getUserAgent } from '../userAgent';
import { mockFs } from '../../mocks.specUtil';

vi.mock('node:fs/promises');
vi.mock('../userAgent');
const fsMocks = mockFs();

const TEST_USER_AGENT = 'TestApp/1.0.0 (test) Electron/0 Chrome/0 Node/0';

describe('BatchConsumer', () => {
  const config: ConsumerConfig = {
    trackPath: 'rum',
    intakeUrl: 'https://intake.datadoghq.com/api/v2/rum',
    clientToken: 'test-client-token',
  };

  let consumer: BatchConsumer;

  beforeEach(() => {
    fsMocks.reset();
    vi.mocked(getUserAgent).mockResolvedValue(TEST_USER_AGENT);
    consumer = new BatchConsumer(config);

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    fsMocks.access.mockResolvedValue(undefined);
  });

  describe('request headers', () => {
    it('should include user agent and client token', async () => {
      fsMocks.readdir.mockResolvedValue(['test.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      await consumer.upload();

      const fetchMock = vi.mocked(fetch);
      const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers['User-Agent']).toBe(TEST_USER_AGENT);
      expect(headers['DD-API-KEY']).toBe(config.clientToken);
    });
  });

  describe('upload lifecycle', () => {
    it('should only process .log files and ignore others', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.tmp']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      await consumer.upload();

      expect(fetch).toHaveBeenCalledTimes(1);
      const expectedPath = path.join(config.trackPath, 'a.log');
      expect(fsMocks.readFile).toHaveBeenCalledWith(expectedPath, 'utf8');
    });

    it('should process multiple log files in alphabetical order', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log', 'c.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      await consumer.upload();

      const fetchMock = vi.mocked(fetch);
      expect(fetchMock.mock.calls).toHaveLength(3);

      expect(fsMocks.readFile).toHaveBeenNthCalledWith(1, path.join(config.trackPath, 'a.log'), 'utf8');
      expect(fsMocks.readFile).toHaveBeenNthCalledWith(3, path.join(config.trackPath, 'c.log'), 'utf8');
    });

    it('should delete file on successful response', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
      await consumer.upload();
      expect(fsMocks.unlink).toHaveBeenCalledTimes(1);
    });

    it('should keep file if request fails', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');

      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);
      await consumer.upload();
      expect(fsMocks.unlink).toHaveBeenCalledTimes(0);
    });
  });

  describe('data parsing', () => {
    it('should filter out invalid JSON and empty lines', async () => {
      fsMocks.readdir.mockResolvedValue(['test.log']);
      const rawContent = ['{"valid": 1}', '   ', 'invalid-json', '{"valid": 2}'].join('\n');

      fsMocks.readFile.mockResolvedValue(rawContent);

      await consumer.upload();

      const fetchMock = vi.mocked(fetch);
      const call = fetchMock.mock.calls[0];

      const body = call[1]?.body;
      if (typeof body === 'string') {
        const sentBody = JSON.parse(body) as unknown[];
        expect(sentBody).toEqual([{ valid: 1 }, { valid: 2 }]);
      }
    });

    it('should delete empty log files without calling fetch', async () => {
      fsMocks.readdir.mockResolvedValue(['empty.log']);
      fsMocks.readFile.mockResolvedValue('');

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should not crash if trackPath is missing', async () => {
      fsMocks.access.mockRejectedValue(new Error('ENOENT'));

      await expect(consumer.upload()).resolves.not.toThrow();
      expect(fsMocks.readdir).not.toHaveBeenCalled();
    });

    it('should handle network exceptions gracefully', async () => {
      fsMocks.readdir.mockResolvedValue(['retry.log']);
      fsMocks.readFile.mockResolvedValue('{"event":"data"}');
      vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(consumer.upload()).resolves.not.toThrow();
      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });
  });
});
