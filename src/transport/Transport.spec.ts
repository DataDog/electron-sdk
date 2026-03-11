import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchSizes, BatchUploadFrequencies } from '../config';
import type { RawEvent, ServerEvent } from '../event';
import { EventKind, EventTrack, EventManager } from '../event';
import { createTestConfiguration } from '../mocks.specUtil';
import { Transport } from './Transport';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

const { mockBatchPost, mockBatchFlush, mockBatchCreate } = vi.hoisted(() => {
  const mockBatchPost = vi.fn();
  const mockBatchFlush = vi.fn().mockResolvedValue(undefined);
  const mockBatchCreate = vi.fn().mockResolvedValue({
    post: mockBatchPost,
    flush: mockBatchFlush,
    stop: vi.fn(),
  });

  return { mockBatchPost, mockBatchFlush, mockBatchCreate };
});

vi.mock('./batch', () => ({
  BatchManager: {
    create: mockBatchCreate,
  },
}));

describe('Transport', () => {
  let eventManager: EventManager;
  let config: ReturnType<typeof createTestConfiguration>;

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    config = createTestConfiguration();
  });

  describe('create', () => {
    it('should register event handlers for known tracks', async () => {
      const spy = vi.spyOn(eventManager, 'registerHandler');
      await Transport.create(config, eventManager);

      expect(spy).toHaveBeenCalled();
    });

    it('should setup batch manager for known tracks', async () => {
      await Transport.create(config, eventManager);

      expect(mockBatchCreate).toHaveBeenCalled();
    });
  });

  describe('event handling', () => {
    it('should handle SERVER events matching domain track type', async () => {
      await Transport.create(config, eventManager);

      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { test: 'data' },
      } as unknown as ServerEvent);

      expect(mockBatchPost).toHaveBeenCalledWith({ test: 'data' });
    });

    it('should not handle events that do not match', async () => {
      await Transport.create(config, eventManager);

      eventManager.notify({
        kind: EventKind.RAW,
        source: 'main-process',
        data: { test: 'data' },
      } as unknown as RawEvent);

      expect(mockBatchPost).not.toHaveBeenCalled();
    });

    it('should not handle SERVER events with different track type', async () => {
      await Transport.create(config, eventManager);

      eventManager.notify({
        kind: EventKind.SERVER,
        track: EventTrack.LOGS,
        data: { test: 'data' },
      });

      expect(mockBatchPost).not.toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('should flush all batch managers', async () => {
      const transport = await Transport.create(config, eventManager);
      await transport.flush();

      expect(mockBatchFlush).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch configuration', () => {
    it('should use default batch size when not specified', async () => {
      await Transport.create(config, eventManager);

      expect(mockBatchCreate).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          batchSize: BatchSizes.MEDIUM,
        })
      );
    });

    it('should use configured batch size', async () => {
      const configWithBatchSize = createTestConfiguration({ batchSize: 'SMALL' });
      await Transport.create(configWithBatchSize, eventManager);

      expect(mockBatchCreate).toHaveBeenCalledWith(
        configWithBatchSize,
        expect.objectContaining({
          batchSize: BatchSizes.SMALL,
        })
      );
    });

    it('should use default upload frequency when not specified', async () => {
      await Transport.create(config, eventManager);

      expect(mockBatchCreate).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          uploadFrequency: BatchUploadFrequencies.NORMAL,
        })
      );
    });

    it('should use configured upload frequency', async () => {
      const configWithFrequency = createTestConfiguration({ uploadFrequency: 'FREQUENT' });
      await Transport.create(configWithFrequency, eventManager);

      expect(mockBatchCreate).toHaveBeenCalledWith(
        configWithFrequency,
        expect.objectContaining({
          uploadFrequency: BatchUploadFrequencies.FREQUENT,
        })
      );
    });
  });
});
