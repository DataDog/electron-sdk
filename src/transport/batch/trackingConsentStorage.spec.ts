import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizePendingBatches,
  clearBatchDirectory,
  recoverAuthorizedPendingBatches,
} from './trackingConsentStorage';

vi.mock('node:fs/promises');
vi.mock('node:crypto', () => ({ randomUUID: () => 'migration-id' }));

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
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([{ name: '.authorized-pending-migration-id', isDirectory: () => true }] as never)
      .mockResolvedValueOnce(['batch-1.log', 'batch-2.tmp'] as never);

    await authorizePendingBatches('/data/rum/pending', '/data/rum');

    expect(fs.rename).toHaveBeenNthCalledWith(1, '/data/rum/pending', '/data/rum/.authorized-pending-migration-id');
    expect(fs.rename).toHaveBeenNthCalledWith(
      2,
      '/data/rum/.authorized-pending-migration-id/batch-1.log',
      '/data/rum/batch-1-pending-migration-id-1.log'
    );
  });

  it('uses names the authorized producer cannot generate without a racy existence check', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([{ name: '.authorized-pending-migration-id', isDirectory: () => true }] as never)
      .mockResolvedValueOnce(['batch-1.log', 'batch-2.log'] as never);

    await authorizePendingBatches('/data/rum/pending', '/data/rum');

    expect(fs.access).not.toHaveBeenCalled();
    expect(fs.rename).toHaveBeenNthCalledWith(
      2,
      '/data/rum/.authorized-pending-migration-id/batch-1.log',
      '/data/rum/batch-1-pending-migration-id-1.log'
    );
    expect(fs.rename).toHaveBeenNthCalledWith(
      3,
      '/data/rum/.authorized-pending-migration-id/batch-2.log',
      '/data/rum/batch-2-pending-migration-id-2.log'
    );
  });

  it('leaves granted files in detached storage when migration fails', async () => {
    const error = new Error('busy');
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([{ name: '.authorized-pending-migration-id', isDirectory: () => true }] as never)
      .mockResolvedValueOnce(['batch-1.log'] as never);
    vi.mocked(fs.rename).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);

    await expect(authorizePendingBatches('/data/rum/pending', '/data/rum')).rejects.toBe(error);
    expect(fs.rm).not.toHaveBeenCalledWith('/data/rum/.authorized-pending-migration-id', expect.anything());
  });

  it('recovers detached granted files independently of the active pending directory', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([
        { name: '.authorized-pending-previous', isDirectory: () => true },
        { name: 'pending', isDirectory: () => true },
      ] as never)
      .mockResolvedValueOnce(['batch-1.log'] as never);

    await recoverAuthorizedPendingBatches('/data/rum');

    expect(fs.rename).toHaveBeenCalledWith(
      '/data/rum/.authorized-pending-previous/batch-1.log',
      '/data/rum/batch-1-pending-previous-1.log'
    );
    expect(fs.rm).toHaveBeenCalledWith('/data/rum/.authorized-pending-previous', {
      recursive: true,
      force: true,
    });
  });
});
