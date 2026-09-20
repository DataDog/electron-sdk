import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchManager } from './BatchManager';
import { EventKind, EventTrack } from '../../event';
import type { ServerEvent } from '../../event';
import { BatchSizes, BatchUploadFrequencies } from '../../config';
import { createTestConfiguration } from '../../mocks.specUtil';
import type { BatchConfig } from './batchConfig.types';
import { createTrackingConsentState } from '../../domain/tracking-consent';

const {
  mockAuthorizedProducerPost,
  mockPendingProducerPost,
  mockAuthorizedProducerFlush,
  mockPendingProducerFlush,
  mockPendingProducerClear,
  mockPendingProducerClearAfterFlush,
  mockPendingProducerRunAfterFlush,
  mockConsumerUpload,
  mockProducerCreate,
  mockProfileProducerCreate,
} = vi.hoisted(() => {
  const mockAuthorizedProducerPost = vi.fn();
  const mockPendingProducerPost = vi.fn();
  const mockAuthorizedProducerFlush = vi.fn().mockResolvedValue(undefined);
  const mockPendingProducerFlush = vi.fn().mockResolvedValue(undefined);
  const mockAuthorizedProducerClear = vi.fn().mockResolvedValue(undefined);
  const mockPendingProducerClear = vi.fn().mockResolvedValue(undefined);
  const mockAuthorizedProducerRunAfterFlush = vi.fn((operation: () => Promise<void>) => operation());
  const mockPendingProducerRunAfterFlush = vi.fn(async (operation: () => Promise<void>) => {
    await mockPendingProducerFlush();
    await operation();
  });
  const mockPendingProducerClearAfterFlush = vi.fn(async (operation: () => Promise<void>) => {
    await mockPendingProducerFlush();
    await operation();
    await mockPendingProducerClear();
  });
  const mockConsumerUpload = vi.fn().mockResolvedValue(undefined);
  const authorizedProducer = {
    post: mockAuthorizedProducerPost,
    flush: mockAuthorizedProducerFlush,
    clear: mockAuthorizedProducerClear,
    runAfterFlush: mockAuthorizedProducerRunAfterFlush,
  };
  const pendingProducer = {
    post: mockPendingProducerPost,
    flush: mockPendingProducerFlush,
    clear: mockPendingProducerClear,
    clearAfterFlush: mockPendingProducerClearAfterFlush,
    runAfterFlush: mockPendingProducerRunAfterFlush,
  };
  const createProducer = (config: { trackPath: string }) =>
    Promise.resolve(config.trackPath.endsWith('/pending') ? pendingProducer : authorizedProducer);
  const mockProducerCreate = vi.fn(createProducer);
  const mockProfileProducerCreate = vi.fn(createProducer);

  return {
    mockAuthorizedProducerPost,
    mockPendingProducerPost,
    mockAuthorizedProducerFlush,
    mockPendingProducerFlush,
    mockPendingProducerClear,
    mockPendingProducerClearAfterFlush,
    mockPendingProducerRunAfterFlush,
    mockConsumerUpload,
    mockProducerCreate,
    mockProfileProducerCreate,
  };
});

vi.mock('./standard/StandardBatchProducer', () => ({
  StandardBatchProducer: { create: mockProducerCreate },
}));

vi.mock('./standard/StandardBatchConsumer', () => ({
  StandardBatchConsumer: vi.fn().mockImplementation(function (this: unknown) {
    return { upload: mockConsumerUpload };
  }),
}));

vi.mock('./profiling/ProfileBatchProducer', () => ({
  ProfileBatchProducer: { create: mockProfileProducerCreate },
}));

vi.mock('./profiling/ProfileBatchConsumer', () => ({
  ProfileBatchConsumer: vi.fn().mockImplementation(function (this: unknown) {
    return { upload: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock('../utils', () => ({
  computeIntakeUrlForTrack: vi.fn(() => 'https://mock-intake.com/api/v2/rum'),
}));

vi.mock('./trackingConsentStorage', () => ({
  clearBatchDirectory: vi.fn().mockResolvedValue(undefined),
  authorizePendingBatches: vi.fn().mockResolvedValue(undefined),
  recoverAuthorizedPendingBatches: vi.fn().mockResolvedValue(undefined),
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
      expect(mockProducerCreate).toHaveBeenCalledWith({
        trackPath: '/mock/path/rum/pending',
        batchSize: BatchSizes.MEDIUM,
      });
    });

    it('limits LOGS batches to the intake maximum of 1,000 entries', async () => {
      await BatchManager.create(config, createBatchConfig({ trackType: EventTrack.LOGS }));

      expect(mockProducerCreate).toHaveBeenCalledWith({
        trackPath: '/mock/path/dd_logs',
        batchSize: BatchSizes.MEDIUM,
        maxEventsPerBatch: 1_000,
      });
      expect(mockProducerCreate).toHaveBeenCalledWith({
        trackPath: '/mock/path/dd_logs/pending',
        batchSize: BatchSizes.MEDIUM,
        maxEventsPerBatch: 1_000,
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

    it('creates a ProfileBatchProducer/Consumer pair for the profile track', async () => {
      const { ProfileBatchConsumer } = await import('./profiling/ProfileBatchConsumer');
      await BatchManager.create(config, createBatchConfig({ trackType: EventTrack.PROFILE }));

      expect(mockProfileProducerCreate).toHaveBeenCalledWith({ trackPath: '/mock/path/profile' });
      expect(mockProfileProducerCreate).toHaveBeenCalledWith({ trackPath: '/mock/path/profile/pending' });
      expect(ProfileBatchConsumer).toHaveBeenCalledWith({
        trackPath: '/mock/path/profile',
        intakeUrl: 'https://mock-intake.com/api/v2/rum',
        clientToken: 'test-token',
      });
      expect(mockProducerCreate).not.toHaveBeenCalled();
    });

    it('should start the upload cycle after creation', async () => {
      await BatchManager.create(config, batchConfig);

      await vi.advanceTimersByTimeAsync(batchConfig.uploadFrequency + 100);

      expect(mockAuthorizedProducerFlush).toHaveBeenCalled();
      expect(mockPendingProducerFlush).toHaveBeenCalled();
      expect(mockConsumerUpload).toHaveBeenCalled();
    });
  });

  describe('post', () => {
    it('should delegate to producer.post', async () => {
      const manager = await BatchManager.create(config, batchConfig);
      const event = {
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { test: 'data' },
      } as unknown as ServerEvent;

      manager.post(event);

      expect(mockAuthorizedProducerPost).toHaveBeenCalledWith(event);
    });

    it('writes pending events only to isolated pending storage', async () => {
      const state = createTrackingConsentState('pending');
      const manager = await BatchManager.create(config, batchConfig, state);
      const event = {
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { test: 'pending' },
      } as unknown as ServerEvent;

      manager.post(event);

      expect(mockPendingProducerPost).toHaveBeenCalledWith(event, expect.any(Promise));
      expect(mockAuthorizedProducerPost).not.toHaveBeenCalled();
    });

    it('does not persist events when consent is not granted', async () => {
      const state = createTrackingConsentState('not-granted');
      const manager = await BatchManager.create(config, batchConfig, state);

      manager.post({ kind: EventKind.SERVER, track: EventTrack.RUM, data: {} } as unknown as ServerEvent);

      expect(mockAuthorizedProducerPost).not.toHaveBeenCalled();
      expect(mockPendingProducerPost).not.toHaveBeenCalled();
    });

    it('routes delayed events using the consent in effect when they were captured', async () => {
      vi.setSystemTime(0);
      const state = createTrackingConsentState('granted');
      const manager = await BatchManager.create(config, batchConfig, state);
      const event = {
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { date: 0 },
      } as unknown as ServerEvent;

      vi.setSystemTime(1);
      state.update('pending');
      manager.post(event);

      expect(mockAuthorizedProducerPost).toHaveBeenCalledWith(event);
      expect(mockPendingProducerPost).not.toHaveBeenCalled();
    });

    it('routes view updates using their update-time consent instead of the view start date', async () => {
      vi.setSystemTime(0);
      const state = createTrackingConsentState('granted');
      const manager = await BatchManager.create(config, batchConfig, state);
      vi.setSystemTime(1);
      state.update('pending');
      const event = {
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { type: 'view', date: 0 },
        consentTime: 1,
      } as unknown as ServerEvent;

      manager.post(event);

      expect(mockAuthorizedProducerPost).not.toHaveBeenCalled();
      expect(mockPendingProducerPost).toHaveBeenCalledWith(event, expect.any(Promise));
    });

    it('authorizes a delayed pending event only when that pending interval was granted', async () => {
      vi.setSystemTime(0);
      const state = createTrackingConsentState('pending');
      const manager = await BatchManager.create(config, batchConfig, state);
      const event = {
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { date: 0 },
      } as unknown as ServerEvent;

      vi.setSystemTime(1);
      state.update('granted');
      manager.post(event);

      expect(mockAuthorizedProducerPost).toHaveBeenCalledWith(event);
    });

    it('never revives a delayed event from a rejected pending interval', async () => {
      vi.setSystemTime(0);
      const state = createTrackingConsentState('pending');
      const manager = await BatchManager.create(config, batchConfig, state);
      const event = {
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { date: 0 },
      } as unknown as ServerEvent;

      vi.setSystemTime(1);
      state.update('not-granted');
      vi.setSystemTime(2);
      state.update('granted');
      manager.post(event);

      expect(mockAuthorizedProducerPost).not.toHaveBeenCalled();
      expect(mockPendingProducerPost).not.toHaveBeenCalled();
    });

    it('drops a completed interval that crossed rejected consent', async () => {
      vi.setSystemTime(0);
      const state = createTrackingConsentState('granted');
      const manager = await BatchManager.create(config, batchConfig, state);
      vi.setSystemTime(10);
      state.update('pending');
      vi.setSystemTime(20);
      state.update('not-granted');
      vi.setSystemTime(30);
      state.update('granted');
      const event = {
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { type: 'vital', date: 5 },
        consentTime: 35,
      } as unknown as ServerEvent;

      manager.post(event);

      expect(mockAuthorizedProducerPost).not.toHaveBeenCalled();
      expect(mockPendingProducerPost).not.toHaveBeenCalled();
    });

    it('honors an explicit storage decision for grouped interval events', async () => {
      const state = createTrackingConsentState('granted');
      const manager = await BatchManager.create(config, batchConfig, state);
      const event = {
        kind: EventKind.SERVER,
        track: EventTrack.SPANS,
        data: { spans: [] },
        storageConsent: 'pending',
      } as unknown as ServerEvent;

      manager.post(event);

      expect(mockPendingProducerPost).toHaveBeenCalledWith(event, expect.any(Promise));
      expect(mockAuthorizedProducerPost).not.toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('should flush producer and upload consumer', async () => {
      const manager = await BatchManager.create(config, batchConfig);
      await manager.flush();

      expect(mockAuthorizedProducerFlush).toHaveBeenCalled();
      expect(mockPendingProducerFlush).toHaveBeenCalled();
      expect(mockConsumerUpload).toHaveBeenCalled();
    });

    it('should skip concurrent flush when one is already in progress', async () => {
      let resolveFlush!: () => void;
      mockAuthorizedProducerFlush.mockReturnValueOnce(new Promise<void>((resolve) => (resolveFlush = resolve)));

      const manager = await BatchManager.create(config, batchConfig);
      const firstFlush = manager.flush();
      const secondFlush = manager.flush();

      resolveFlush();
      await firstFlush;
      await secondFlush;

      expect(mockAuthorizedProducerFlush).toHaveBeenCalledTimes(1);
      expect(mockPendingProducerFlush).toHaveBeenCalledTimes(1);
      expect(mockConsumerUpload).toHaveBeenCalledTimes(1);
    });

    it('runs a fresh cycle after an in-flight scheduled cycle instead of dropping the flush', async () => {
      let resolveScheduled!: () => void;
      mockAuthorizedProducerFlush.mockReturnValueOnce(new Promise<void>((resolve) => (resolveScheduled = resolve)));

      const manager = await BatchManager.create(config, batchConfig);

      // Fire the periodic cycle; its producer.flush() stays pending, simulating an in-flight upload.
      await vi.advanceTimersByTimeAsync(batchConfig.uploadFrequency);
      expect(mockAuthorizedProducerFlush).toHaveBeenCalledTimes(1);
      expect(mockPendingProducerFlush).not.toHaveBeenCalled();
      expect(mockConsumerUpload).not.toHaveBeenCalled();

      // A flush() arriving now (e.g. on quit, after a final segment was rotated) must not be dropped:
      // it queues a full cycle behind the active one so the newly rotated files are uploaded.
      const flushPromise = manager.flush();
      resolveScheduled();
      await flushPromise;

      expect(mockAuthorizedProducerFlush).toHaveBeenCalledTimes(2);
      expect(mockPendingProducerFlush).toHaveBeenCalledTimes(2);
      expect(mockConsumerUpload).toHaveBeenCalledTimes(2);

      manager.stop();
    });

    it('continues uploading previously authorized batches when consent is not granted', async () => {
      const state = createTrackingConsentState('not-granted');
      const manager = await BatchManager.create(config, batchConfig, state);

      await manager.flush();

      expect(mockConsumerUpload).toHaveBeenCalledOnce();
    });

    it('flushes pending storage before authorizing it on grant', async () => {
      const state = createTrackingConsentState('pending');
      const manager = await BatchManager.create(config, batchConfig, state);

      state.update('granted');
      await manager.flush();

      expect(mockPendingProducerRunAfterFlush).toHaveBeenCalled();
      expect(mockConsumerUpload).toHaveBeenCalledOnce();
    });

    it('clears pending storage when consent is rejected', async () => {
      const state = createTrackingConsentState('pending');
      const manager = await BatchManager.create(config, batchConfig, state);

      state.update('not-granted');
      await manager.flush();

      expect(mockPendingProducerClear).toHaveBeenCalledOnce();
    });

    it('clears the pending destination before entering pending', async () => {
      const state = createTrackingConsentState('granted');
      const manager = await BatchManager.create(config, batchConfig, state);

      state.update('pending');
      await manager.flush();

      expect(mockPendingProducerClear).toHaveBeenCalledOnce();
    });

    it('reserves the pending clear before lifecycle observers can post new events', async () => {
      const state = createTrackingConsentState('not-granted');
      const manager = await BatchManager.create(config, batchConfig, state);
      state.observable.subscribe(() => {
        manager.post({ kind: EventKind.SERVER, track: EventTrack.RUM, data: {} } as unknown as ServerEvent);
      });

      state.update('pending');

      expect(mockPendingProducerClearAfterFlush.mock.invocationCallOrder[0]).toBeLessThan(
        mockPendingProducerPost.mock.invocationCallOrder[0]
      );
    });

    it('does not authorize rejected files after a failed clear and a later grant', async () => {
      const { authorizePendingBatches } = await import('./trackingConsentStorage');
      const state = createTrackingConsentState('pending');
      const manager = await BatchManager.create(config, batchConfig, state);
      mockPendingProducerClear.mockRejectedValueOnce(new Error('clear failed'));

      state.update('not-granted');
      await manager.flush();
      state.update('granted');
      await manager.flush();

      expect(authorizePendingBatches).not.toHaveBeenCalled();
    });

    it('does not authorize a pending interval whose quarantine clear failed', async () => {
      const { authorizePendingBatches } = await import('./trackingConsentStorage');
      const state = createTrackingConsentState('pending');
      const manager = await BatchManager.create(config, batchConfig, state);
      mockPendingProducerClear.mockRejectedValueOnce(new Error('denial clear failed'));

      state.update('not-granted');
      await manager.flush();

      state.update('pending');
      state.update('granted');
      await manager.flush();

      expect(authorizePendingBatches).not.toHaveBeenCalled();
      expect(mockPendingProducerClear).toHaveBeenCalledOnce();
    });

    it('does not clear granted pending batches until their detachment succeeds', async () => {
      const { authorizePendingBatches } = await import('./trackingConsentStorage');
      const error = new Error('directory busy');
      vi.mocked(authorizePendingBatches).mockRejectedValue(error);
      const state = createTrackingConsentState('pending');
      const manager = await BatchManager.create(config, batchConfig, state);

      state.update('granted');
      state.update('pending');
      const pendingEvent = {
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { test: 'quarantined' },
      } as unknown as ServerEvent;
      manager.post(pendingEvent);
      // Repeat the transition before any queued storage operation settles. A quarantined interval
      // must not bypass the earlier authorization failure and clear its files.
      state.update('granted');
      state.update('pending');

      await expect(manager.flush()).rejects.toBe(error);
      expect(mockPendingProducerClearAfterFlush).toHaveBeenCalled();
      expect(mockPendingProducerClear).not.toHaveBeenCalled();
      const failedReadiness = mockPendingProducerPost.mock.calls[0][1] as Promise<boolean>;
      await expect(failedReadiness).resolves.toBe(false);

      vi.mocked(authorizePendingBatches).mockResolvedValue(undefined);
      await manager.flush();
      mockPendingProducerPost.mockClear();
      manager.post(pendingEvent);

      expect(mockPendingProducerClear).toHaveBeenCalledOnce();
      const recoveredReadiness = mockPendingProducerPost.mock.calls[0][1] as Promise<boolean>;
      await expect(recoveredReadiness).resolves.toBe(true);
    });
  });

  describe('stop', () => {
    it('should stop the upload cycle', async () => {
      const manager = await BatchManager.create(config, batchConfig);
      manager.stop();

      mockAuthorizedProducerFlush.mockClear();
      mockPendingProducerFlush.mockClear();
      mockConsumerUpload.mockClear();

      await vi.advanceTimersByTimeAsync(batchConfig.uploadFrequency * 2);

      expect(mockAuthorizedProducerFlush).not.toHaveBeenCalled();
      expect(mockPendingProducerFlush).not.toHaveBeenCalled();
      expect(mockConsumerUpload).not.toHaveBeenCalled();
    });
  });

  describe('upload cycle', () => {
    it('should schedule recurring uploads at configured frequency', async () => {
      const manager = await BatchManager.create(config, batchConfig);

      await vi.advanceTimersByTimeAsync(batchConfig.uploadFrequency + 100);
      expect(mockAuthorizedProducerFlush).toHaveBeenCalledTimes(1);
      expect(mockPendingProducerFlush).toHaveBeenCalledTimes(1);
      expect(mockConsumerUpload).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(batchConfig.uploadFrequency);
      expect(mockAuthorizedProducerFlush).toHaveBeenCalledTimes(2);
      expect(mockPendingProducerFlush).toHaveBeenCalledTimes(2);
      expect(mockConsumerUpload).toHaveBeenCalledTimes(2);

      manager.stop();
    });
  });
});
