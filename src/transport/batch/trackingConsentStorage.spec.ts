import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizePendingBatches, clearBatchDirectory } from './trackingConsentStorage';

vi.mock('node:fs/promises');

describe('tracking consent storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.rename).mockResolvedValue(undefined);
  });

  it('clears stale pending storage recursively', async () => {
    vi.mocked(fs.rm).mockResolvedValue(undefined);

    await clearBatchDirectory('/data/rum/pending');

    expect(fs.rm).toHaveBeenCalledWith('/data/rum/pending', { recursive: true, force: true });
  });

  it('moves only complete pending batches into authorized storage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(42);
    vi.mocked(fs.readdir).mockResolvedValue(['batch-1.log', 'batch-2.tmp'] as never);

    await authorizePendingBatches('/data/rum/pending', '/data/rum');

    expect(fs.rename).toHaveBeenCalledOnce();
    expect(fs.rename).toHaveBeenCalledWith('/data/rum/pending/batch-1.log', '/data/rum/batch-1-pending-42-1.log');
    vi.useRealTimers();
  });

  it('uses names the authorized producer cannot generate without a racy existence check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(42);
    vi.mocked(fs.readdir).mockResolvedValue(['batch-1.log', 'batch-2.log'] as never);

    await authorizePendingBatches('/data/rum/pending', '/data/rum');

    expect(fs.access).not.toHaveBeenCalled();
    expect(fs.rename).toHaveBeenNthCalledWith(1, '/data/rum/pending/batch-1.log', '/data/rum/batch-1-pending-42-1.log');
    expect(fs.rename).toHaveBeenNthCalledWith(2, '/data/rum/pending/batch-2.log', '/data/rum/batch-2-pending-42-2.log');
    vi.useRealTimers();
  });

  it('leaves pending files in place when migration fails', async () => {
    const error = new Error('busy');
    vi.mocked(fs.readdir).mockResolvedValue(['batch-1.log'] as never);
    vi.mocked(fs.rename).mockRejectedValue(error);

    await expect(authorizePendingBatches('/data/rum/pending', '/data/rum')).rejects.toBe(error);
  });
});
