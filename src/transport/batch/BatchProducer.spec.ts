import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { BatchProducer } from './BatchProducer';
import type { ProducerConfig } from './BatchProducer';
import { mockFs } from '../../mocks.specUtil';

vi.mock('node:fs/promises');
const fsMocks = mockFs();

vi.mock('@datadog/browser-core', () => ({
  dateNow: vi.fn(() => 1234567890),
}));

function makeConfig(overrides: Partial<ProducerConfig> = {}): ProducerConfig {
  return {
    trackPath: '/mock/track/path',
    batchSize: 1024,
    ...overrides,
  };
}

describe('BatchProducer', () => {
  let config: ProducerConfig;

  beforeEach(() => {
    fsMocks.reset();
    config = makeConfig();

    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.appendFile.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('create()', () => {
    it('creates track directory when missing', async () => {
      fsMocks.access.mockRejectedValueOnce(new Error('ENOENT'));

      await BatchProducer.create(config);

      expect(fsMocks.mkdir).toHaveBeenCalledWith(config.trackPath, { recursive: true });
    });

    it('does not create directory when it exists', async () => {
      fsMocks.access.mockResolvedValueOnce(undefined);

      await BatchProducer.create(config);

      expect(fsMocks.mkdir).not.toHaveBeenCalled();
    });
  });

  describe('post() + write queue', () => {
    it('serializes each post as JSON + newline and appends to the same .tmp file until rotation', async () => {
      const producer = await BatchProducer.create(config);

      producer.post({ a: 1 });
      producer.post({ b: 2 });
      await producer.flush();

      const tmp = path.join(config.trackPath, 'batch-1234567890.tmp');

      expect(fsMocks.appendFile).toHaveBeenCalledTimes(2);
      expect(fsMocks.appendFile).toHaveBeenNthCalledWith(1, tmp, `{"a":1}\n`, 'utf8');
      expect(fsMocks.appendFile).toHaveBeenNthCalledWith(2, tmp, `{"b":2}\n`, 'utf8');
    });

    it('writes posts in call order', async () => {
      const producer = await BatchProducer.create(config);

      producer.post({ order: 1 });
      producer.post({ order: 2 });
      producer.post({ order: 3 });

      await producer.flush();

      expect(fsMocks.appendFile).toHaveBeenCalledTimes(3);

      expect(fsMocks.appendFile.mock.calls[0][1]).toBe(`{"order":1}\n`);
      expect(fsMocks.appendFile.mock.calls[1][1]).toBe(`{"order":2}\n`);
      expect(fsMocks.appendFile.mock.calls[2][1]).toBe(`{"order":3}\n`);
    });

    it('swallows appendFile errors and keeps queue processing subsequent posts', async () => {
      fsMocks.appendFile.mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(undefined);

      const producer = await BatchProducer.create(config);

      producer.post({ bad: true });
      producer.post({ good: true });

      await expect(producer.flush()).resolves.not.toThrow();
      expect(fsMocks.appendFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('rotation behavior', () => {
    it('flush() renames current batch from .tmp to .log', async () => {
      const producer = await BatchProducer.create(config);

      producer.post({ event: 'test' });
      await producer.flush();

      const tmp = path.join(config.trackPath, 'batch-1234567890.tmp');
      const log = path.join(config.trackPath, 'batch-1234567890.log');

      expect(fsMocks.rename).toHaveBeenCalledWith(tmp, log);
    });

    it('flush() does nothing if no data was ever written', async () => {
      const producer = await BatchProducer.create(config);

      await producer.flush();

      expect(fsMocks.appendFile).not.toHaveBeenCalled();
      expect(fsMocks.rename).not.toHaveBeenCalled();
    });

    it('rotates due to size limit BEFORE appending when current batch already has data', async () => {
      const small = makeConfig({ batchSize: 20 });

      const producer = await BatchProducer.create(small);

      const { dateNow } = await import('@datadog/browser-core');
      vi.mocked(dateNow)
        .mockReturnValueOnce(111) // first tmp
        .mockReturnValueOnce(222); // second tmp after rotation

      producer.post({ x: '123' });
      producer.post({ x: '123' });
      await producer.flush();

      const tmp1 = path.join(small.trackPath, 'batch-111.tmp');
      const log1 = path.join(small.trackPath, 'batch-111.log');
      const tmp2 = path.join(small.trackPath, 'batch-222.tmp');
      const log2 = path.join(small.trackPath, 'batch-222.log');

      expect(fsMocks.appendFile).toHaveBeenCalledTimes(2);
      expect(fsMocks.appendFile).toHaveBeenNthCalledWith(1, tmp1, `{"x":"123"}\n`, 'utf8');
      expect(fsMocks.appendFile).toHaveBeenNthCalledWith(2, tmp2, `{"x":"123"}\n`, 'utf8');

      expect(fsMocks.rename).toHaveBeenCalledWith(tmp1, log1);
      expect(fsMocks.rename).toHaveBeenCalledWith(tmp2, log2);
    });

    it('swallows rename/access errors during rotation and still resets state (new batch file is created after)', async () => {
      const { dateNow } = await import('@datadog/browser-core');
      vi.mocked(dateNow).mockReturnValueOnce(1000).mockReturnValueOnce(2000);

      fsMocks.rename.mockRejectedValueOnce(new Error('rename failed'));

      const producer = await BatchProducer.create(config);

      producer.post({ first: true });
      await producer.flush();

      producer.post({ second: true });
      await producer.flush();

      const tmp1 = path.join(config.trackPath, 'batch-1000.tmp');
      const tmp2 = path.join(config.trackPath, 'batch-2000.tmp');

      const appendedFiles = fsMocks.appendFile.mock.calls.map((c) => String(c[0]));
      expect(appendedFiles).toContain(tmp1);
      expect(appendedFiles).toContain(tmp2);
    });
  });

  describe('directory handling', () => {
    it('calls mkdir recursively when directory is missing during a write', async () => {
      // create() consumes one ensureTrackDirectory call and we want the failure to happen during writeData().
      // So we make create succeed and then fail for the subsequent access.
      fsMocks.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ENOENT'));

      const producer = await BatchProducer.create(config);

      producer.post({ event: 'test' });
      await producer.flush();

      expect(fsMocks.mkdir).toHaveBeenCalledWith(config.trackPath, { recursive: true });
    });

    it('does not mkdir when access succeeds during a write', async () => {
      const producer = await BatchProducer.create(config);

      producer.post({ event: 'test' });
      await producer.flush();

      expect(fsMocks.mkdir).not.toHaveBeenCalled();
    });
  });
});
