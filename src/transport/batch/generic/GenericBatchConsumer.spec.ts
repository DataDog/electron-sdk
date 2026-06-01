import { describe, it, expect, vi, beforeEach } from 'vitest';
<<<<<<< HEAD:src/transport/batch/BatchConsumer.spec.ts
import { BatchConsumer } from './BatchConsumer';
import type { BatchConsumerConfig } from './BatchConsumer';
import { getUserAgent } from '../userAgent';
import { mockFs } from '../../mocks.specUtil';
=======
import { GenericBatchConsumer } from './GenericBatchConsumer';
import type { BatchConsumerConfig as ConsumerConfig } from '../types';
import type { BatchConsumer } from '../BatchConsumer';
import path from 'node:path';
import { getUserAgent } from '../../userAgent';
import { mockFs } from '../../../mocks.specUtil';
>>>>>>> fb1f12c (Refactor transport to make BatchProducer/Consumer extensible for new transport strategies):src/transport/batch/generic/GenericBatchConsumer.spec.ts

vi.mock('node:fs/promises');
vi.mock('../../userAgent');
const fsMocks = mockFs();

const TEST_USER_AGENT = 'TestApp/1.0.0';
const TEST_REQUEST = new Request('https://intake.datadoghq.com/api/v2/rum', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '[]',
});

<<<<<<< HEAD:src/transport/batch/BatchConsumer.spec.ts
const config: BatchConsumerConfig = {
  trackPath: '/mock/track',
  intakeUrl: 'https://intake.datadoghq.com/api/v2/rum',
  clientToken: 'test-token',
};
=======
describe('GenericBatchConsumer', () => {
  const config: ConsumerConfig = {
    trackPath: 'rum',
    intakeUrl: 'https://intake.datadoghq.com/api/v2/rum',
    clientToken: 'test-client-token',
  };
>>>>>>> fb1f12c (Refactor transport to make BatchProducer/Consumer extensible for new transport strategies):src/transport/batch/generic/GenericBatchConsumer.spec.ts

/** Minimal concrete subclass for testing the base-class upload logic. */
class TestConsumer extends BatchConsumer {
  constructor(
    config: BatchConsumerConfig,
    private readonly requestToReturn: Request | null
  ) {
    super(config);
  }

  protected buildRequest(): Request | null {
    return this.requestToReturn;
  }
}

describe('BatchConsumer — upload/send/delete behaviour', () => {
  beforeEach(() => {
    fsMocks.reset();
    vi.mocked(getUserAgent).mockReset().mockReturnValue(TEST_USER_AGENT);
<<<<<<< HEAD:src/transport/batch/BatchConsumer.spec.ts
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
=======
    consumer = new GenericBatchConsumer(config);

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
>>>>>>> fb1f12c (Refactor transport to make BatchProducer/Consumer extensible for new transport strategies):src/transport/batch/generic/GenericBatchConsumer.spec.ts
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.unlink.mockResolvedValue(undefined);
  });

  describe('when buildRequest returns null (empty / malformed batch)', () => {
    it('deletes the file without calling fetch', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockResolvedValue('');

      const consumer = new TestConsumer(config, null);
      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledOnce();
    });
  });

  describe('when buildRequest returns a Request', () => {
    it('sends the request via fetch', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockResolvedValue('{"event":1}');

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();

      expect(fetch).toHaveBeenCalledWith(TEST_REQUEST);
    });

    it('deletes the file on a successful response', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockResolvedValue('{"event":1}');

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();

      expect(fsMocks.unlink).toHaveBeenCalledOnce();
    });

    it('keeps the file when the intake returns a non-ok response', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockResolvedValue('{"event":1}');
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();

      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });

    it('keeps the file when fetch throws a network error', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockResolvedValue('{"event":1}');
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await expect(consumer.upload()).resolves.not.toThrow();
      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });

    it('processes multiple log files in sequence', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log']);
      fsMocks.readFile.mockResolvedValue('{"event":1}');

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fsMocks.unlink).toHaveBeenCalledTimes(2);
    });
  });

  describe('getUserAgent lazy initialisation', () => {
    it('calls getUserAgent only once across multiple upload() calls', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log']);
      fsMocks.readFile.mockResolvedValue('{"event":1}');

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();
      await consumer.upload();

      expect(getUserAgent).toHaveBeenCalledTimes(1);
    });

    it('does not crash when the track directory does not exist', async () => {
      fsMocks.access.mockRejectedValue(new Error('ENOENT'));
      const consumer = new TestConsumer(config, TEST_REQUEST);
      await expect(consumer.upload()).resolves.not.toThrow();
    });
  });
});
