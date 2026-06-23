import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchManager } from './BatchManager';
import { EventTrack } from '../../event';
import { BatchSizes, BatchUploadFrequencies } from '../../config';
import { createTestConfiguration } from '../../mocks.specUtil';
import type { BatchConfig } from './batchConfig.types';

const { mockProducerPost, mockProducerFlush, mockConsumerUpload, mockProducerCreate } = vi.hoisted(() => {
  const mockProducerPost = vi.fn();
  const mockProducerFlush = vi.fn().mockResolvedValue(undefined);
  const mockConsumerUpload = vi.fn().mockResolvedValue(undefined);
  const mockProducerCreate = vi.fn().mockResolvedValue({
    post: mockProducerPost,
    flush: mockProducerFlush,
  });

  return { mockProducerPost, mockProducerFlush, mockConsumerUpload, mockProducerCreate };
});

vi.mock('./standard/StandardBatchProducer', () => ({
  StandardBatchProducer: { create: mockProducerCreate },
}));

vi.mock('./standard/StandardBatchConsumer', () => ({
  StandardBatchConsumer: vi.fn().mockImplementation(function (this: unknown) {
    return { upload: mockConsumerUpload };
  }),
}));

vi.mock('../utils', () => ({
  computeIntakeUrlForTrack: vi.fn(() => 'https://mock-intake.com/api/v2/rum'),
}));

function createBatchConfig(overrides?: Partial<BatchConfig>): BatchConfig {
  return {
    path: '/mock/path',
    trackType: EventTrack.RUM,
    batchSize: BatchSizes.MEDIUM,
    uploadFrequency: BatchUploadFrequencies.NORMAL,
    ...overrides,
  };
}

describe('BatchManager', () => {
  let config: ReturnType<typeof createTestConfiguration>;
  let batchConfig: BatchConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    config = createTestConfiguration();
    batchConfig = createBatchConfig();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create — producer/consumer wiring', () => {
    it('creates a StandardBatchProducer with the resolved trackPath and batchSize for standard tracks', async () => {
      await BatchManager.create(config, batchConfig);

      expect(mockProducerCreate).toHaveBeenCalledWith({
        trackPath: '/mock/path/rum',
        batchSize: BatchSizes.MEDIUM,
      });
    });

    it('creates a StandardBatchConsumer with the resolved trackPath, intakeUrl and clientToken', async () => {
      const { StandardBatchConsumer } = await import('./standard/StandardBatchConsumer');
      await BatchManager.create(config, batchConfig);

      expect(StandardBatchConsumer).toHaveBeenCalledWith({
        trackPath: '/mock/path/rum',
        intakeUrl: 'https://mock-intake.com/api/v2/rum',
        clientToken: 'test-token',
      });
    });

    it('should start the upload cycle after creation', async () => {
      await BatchManager.create(config, batchConfig);

      await vi.advanceTimersByTimeAsync(batchConfig.uploadFrequency + 100);

      expect(mockProducerFlush).toHaveBeenCalled();
      expect(mockConsumerUpload).toHaveBeenCalled();
    });
  });

  describe('post', () => {
    it('should delegate to producer.post', async () => {
      const manager = await BatchManager.create(config, batchConfig);
      const data = { test: 'data' };

      manager.post(data);

      expect(mockProducerPost).toHaveBeenCalledWith(data);
    });
  });

  describe('flush', () => {
    it('should flush producer and upload consumer', async () => {
      const manager = await BatchManager.create(config, batchConfig);
      await manager.flush();

      expect(mockProducerFlush).toHaveBeenCalled();
      expect(mockConsumerUpload).toHaveBeenCalled();
    });

    it('should skip concurrent flush when one is already in progress', async () => {
      let resolveFlush!: () => void;
      mockProducerFlush.mockReturnValueOnce(new Promise<void>((resolve) => (resolveFlush = resolve)));

      const manager = await BatchManager.create(config, batchConfig);
      const firstFlush = manager.flush();
      const secondFlush = manager.flush();

      resolveFlush();
      await firstFlush;
      await secondFlush;

      expect(mockProducerFlush).toHaveBeenCalledTimes(1);
      expect(mockConsumerUpload).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('should stop the upload cycle', async () => {
      const manager = await BatchManager.create(config, batchConfig);
      manager.stop();

      mockProducerFlush.mockClear();
      mockConsumerUpload.mockClear();

      await vi.advanceTimersByTimeAsync(batchConfig.uploadFrequency * 2);

      expect(mockProducerFlush).not.toHaveBeenCalled();
      expect(mockConsumerUpload).not.toHaveBeenCalled();
    });
  });

  describe('upload cycle', () => {
    it('should schedule recurring uploads at configured frequency', async () => {
      const manager = await BatchManager.create(config, batchConfig);

      await vi.advanceTimersByTimeAsync(batchConfig.uploadFrequency + 100);
      expect(mockProducerFlush).toHaveBeenCalledTimes(1);
      expect(mockConsumerUpload).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(batchConfig.uploadFrequency);
      expect(mockProducerFlush).toHaveBeenCalledTimes(2);
      expect(mockConsumerUpload).toHaveBeenCalledTimes(2);

      manager.stop();
    });
  });
});
