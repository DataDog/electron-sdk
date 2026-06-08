import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { ProfileBatchManager } from './ProfileBatchManager';
import { ProfileBatchConsumer } from './ProfileBatchConsumer';
import { createTestConfiguration } from '../../../mocks.specUtil';

const { mockPost, mockProducerCreate, mockUpload } = vi.hoisted(() => {
  const mockPost = vi.fn();
  const mockUpload = vi.fn().mockResolvedValue(undefined);
  const mockProducerCreate = vi.fn().mockResolvedValue({ post: mockPost });
  return { mockPost, mockProducerCreate, mockUpload };
});

vi.mock('./ProfileBatchProducer', () => ({
  ProfileBatchProducer: { create: mockProducerCreate },
}));

vi.mock('./ProfileBatchConsumer', () => ({
  ProfileBatchConsumer: vi.fn().mockImplementation(function () {
    return { upload: mockUpload };
  }),
}));

vi.mock('../../utils', () => ({
  computeIntakeUrlForTrack: vi.fn(() => 'https://mock-intake.com/api/v2/profile'),
}));

describe('ProfileBatchManager', () => {
  const config = createTestConfiguration();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create()', () => {
    it('creates producer with the profiling track path', async () => {
      await ProfileBatchManager.create(config, { path: '/data', uploadFrequency: 10000 });

      expect(mockProducerCreate).toHaveBeenCalledWith(path.join('/data', 'profile'));
    });

    it('creates consumer with intake URL and client token', async () => {
      await ProfileBatchManager.create(config, { path: '/data', uploadFrequency: 10000 });

      expect(ProfileBatchConsumer).toHaveBeenCalledWith({
        trackPath: path.join('/data', 'profile'),
        intakeUrl: 'https://mock-intake.com/api/v2/profile',
        clientToken: config.clientToken,
      });
    });

    it('starts periodic upload cycle', async () => {
      await ProfileBatchManager.create(config, { path: '/data', uploadFrequency: 10000 });

      await vi.advanceTimersByTimeAsync(10100);

      expect(mockUpload).toHaveBeenCalled();
    });
  });

  describe('post()', () => {
    it('delegates to the producer', async () => {
      const manager = await ProfileBatchManager.create(config, { path: '/data', uploadFrequency: 10000 });
      const data = { event: { session: { id: 's1' } }, trace: {} } as never;

      manager.post(data);

      expect(mockPost).toHaveBeenCalledWith(data);
    });
  });

  describe('flush()', () => {
    it('triggers an upload immediately', async () => {
      const manager = await ProfileBatchManager.create(config, { path: '/data', uploadFrequency: 10000 });

      await manager.flush();

      expect(mockUpload).toHaveBeenCalledTimes(1);
    });

    it('skips concurrent flush when one is in progress', async () => {
      let resolve!: () => void;
      mockUpload.mockReturnValueOnce(new Promise<void>((r) => (resolve = r)));

      const manager = await ProfileBatchManager.create(config, { path: '/data', uploadFrequency: 10000 });
      const first = manager.flush();
      const second = manager.flush();

      resolve();
      await first;
      await second;

      expect(mockUpload).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('cancels the periodic cycle', async () => {
      const manager = await ProfileBatchManager.create(config, { path: '/data', uploadFrequency: 10000 });
      manager.stop();
      mockUpload.mockClear();

      await vi.advanceTimersByTimeAsync(20000);

      expect(mockUpload).not.toHaveBeenCalled();
    });
  });
});
