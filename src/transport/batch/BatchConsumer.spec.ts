import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BatchConsumer } from './BatchConsumer';
import type { BatchConsumerConfig } from './BatchConsumer';
import { getUserAgent } from '../userAgent';
import { mockFs } from '../../mocks.specUtil';
import { display } from '../../tools/display';

vi.mock('node:fs/promises');
vi.mock('../userAgent');
vi.mock('../../tools/display', () => ({
  display: { warn: vi.fn(), error: vi.fn() },
}));
const fsMocks = mockFs();

const TEST_USER_AGENT = 'TestApp/1.0.0';
const TEST_REQUEST = new Request('https://intake.datadoghq.com/api/v2/rum', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '[]',
});

function fsError(code: string) {
  return Object.assign(new Error(`${code}: read failed`), { code });
}

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
    vi.mocked(display.warn).mockClear();
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
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

  describe('when a batch file cannot be read', () => {
    it('keeps the file and does not upload it', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockRejectedValue(fsError('EBUSY'));

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });

    it('uploads and deletes the file on the next cycle once it is readable', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockRejectedValueOnce(fsError('EBUSY')).mockResolvedValueOnce('{"event":1}');

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();
      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).not.toHaveBeenCalled();

      await consumer.upload();
      expect(fetch).toHaveBeenCalledOnce();
      expect(fsMocks.unlink).toHaveBeenCalledOnce();
    });

    it('still uploads the other files of the cycle', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log']);
      fsMocks.readFile.mockImplementation((filePath: string) =>
        filePath.endsWith('a.log') ? Promise.reject(fsError('EBUSY')) : Promise.resolve('{"event":1}')
      );

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();

      expect(fetch).toHaveBeenCalledOnce();
      expect(fsMocks.unlink).toHaveBeenCalledExactlyOnceWith('/mock/track/b.log');
    });

    it('warns once per file with the path and the error', async () => {
      const errorA = fsError('EBUSY');
      const errorB = fsError('EMFILE');
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.log']);
      fsMocks.readFile.mockImplementation((filePath: string) =>
        Promise.reject(filePath.endsWith('a.log') ? errorA : errorB)
      );

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();
      await consumer.upload();

      expect(display.warn).toHaveBeenCalledTimes(2);
      expect(display.warn).toHaveBeenCalledWith(expect.any(String), '/mock/track/a.log', errorA);
      expect(display.warn).toHaveBeenCalledWith(expect.any(String), '/mock/track/b.log', errorB);
    });

    it('skips a file deleted after being listed without warning', async () => {
      fsMocks.readdir.mockResolvedValue(['batch.log']);
      fsMocks.readFile.mockRejectedValue(fsError('ENOENT'));

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();

      expect(display.warn).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });

    it('warns again for a file that left the listing and came back failing', async () => {
      fsMocks.readdir
        .mockResolvedValueOnce(['batch.log'])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(['batch.log']);
      fsMocks.readFile.mockRejectedValue(fsError('EBUSY'));

      const consumer = new TestConsumer(config, TEST_REQUEST);
      await consumer.upload();
      await consumer.upload();
      await consumer.upload();

      expect(display.warn).toHaveBeenCalledTimes(2);
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
