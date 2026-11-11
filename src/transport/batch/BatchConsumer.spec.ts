import { describe, it, expect, vi, beforeEach } from 'vitest';
import { display } from '../../tools/display';
import { BatchConsumer } from './BatchConsumer';
import type { BatchConsumerConfig } from './BatchConsumer';
import { getUserAgent } from '../userAgent';
import { createFsError, mockFs } from '../../mocks.specUtil';

vi.mock('node:fs/promises');
vi.mock('../userAgent');
vi.mock('../../tools/display', () => ({
  display: { warn: vi.fn() },
}));
const fsMocks = mockFs();

const TEST_USER_AGENT = 'TestApp/1.0.0';
const TEST_REQUEST = new Request('https://intake.datadoghq.com/api/v2/rum', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '[]',
});

const config: BatchConsumerConfig = {
  trackPath: '/mock/track',
  intakeUrl: 'https://intake.datadoghq.com/api/v2/rum',
  clientToken: 'test-token',
};

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
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.unlink.mockResolvedValue(undefined);
    vi.mocked(display.warn).mockReset();
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

    it.each([400, 401, 403, 404, 413, 422])(
      'deletes a batch rejected with HTTP %i and continues uploading later batches',
      async (status) => {
        const files = new Set(['a.log', 'b.log']);
        fsMocks.readdir.mockImplementation(() => Promise.resolve([...files]));
        fsMocks.readFile.mockResolvedValue('{"event":1}');
        fsMocks.unlink.mockImplementation((file) => {
          files.delete(String(file).split('/').pop()!);
          return Promise.resolve();
        });
        vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status } as Response);
        const consumer = new TestConsumer(config, TEST_REQUEST);

        await consumer.upload();
        await consumer.upload();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fsMocks.unlink).toHaveBeenCalledWith('/mock/track/a.log');
        expect(fsMocks.unlink).toHaveBeenCalledWith('/mock/track/b.log');
        expect(display.warn).toHaveBeenCalledWith(expect.stringContaining(String(status)));
      }
    );

    it.each([408, 429, 500, 503])('keeps the file for retry on HTTP %i', async (status) => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockResolvedValue('{"event":1}');
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status } as Response);

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

  describe('when a batch file cannot be read', () => {
    it('keeps the file and uploads it on the first later cycle whose read succeeds', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockRejectedValueOnce(createFsError('EBUSY')).mockResolvedValueOnce('{"event":1}');
      const consumer = new TestConsumer(config, TEST_REQUEST);

      await consumer.upload();
      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).not.toHaveBeenCalled();

      await consumer.upload();
      expect(fetch).toHaveBeenCalledWith(TEST_REQUEST);
      expect(fsMocks.unlink).toHaveBeenCalledWith('/mock/track/batch.log');
    });

    it('uploads the other files of the track in the same cycle', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log']);
      fsMocks.readFile.mockRejectedValueOnce(createFsError('EACCES')).mockResolvedValueOnce('{"event":1}');

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();

      expect(fetch).toHaveBeenCalledOnce();
      expect(fsMocks.unlink).toHaveBeenCalledExactlyOnceWith('/mock/track/b.log');
    });

    it('warns once per file, naming the file and the error', async () => {
      const error = createFsError('EBUSY');
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockRejectedValue(error);

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();
      await consumer.upload();
      await consumer.upload();

      expect(display.warn).toHaveBeenCalledExactlyOnceWith(
        'Failed to read batch file, keeping it for the next upload:',
        '/mock/track/batch.log',
        error
      );
    });

    it('warns again for a file that left the track directory and came back', async () => {
      fsMocks.readFile.mockRejectedValue(createFsError('EBUSY'));
      const consumer = new TestConsumer(config, TEST_REQUEST);

      fsMocks.readdir.mockResolvedValueOnce(['batch.log']);
      await consumer.upload();
      fsMocks.readdir.mockResolvedValueOnce([]);
      await consumer.upload();
      fsMocks.readdir.mockResolvedValueOnce(['batch.log']);
      await consumer.upload();

      expect(display.warn).toHaveBeenCalledTimes(2);
    });

    it('stays silent for a file removed between listing and reading', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log']);
      fsMocks.readFile.mockRejectedValueOnce(createFsError('ENOENT')).mockResolvedValueOnce('{"event":1}');

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();

      expect(display.warn).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
      expect(fsMocks.unlink).toHaveBeenCalledExactlyOnceWith('/mock/track/b.log');
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
