import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evictBatchFiles } from './batchFileEviction';

vi.mock('node:fs/promises');

describe('batch file eviction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
  });

  it('applies one limit across directories and orders completed batches by their filenames', async () => {
    const firstDirectory = '/track/pending-z';
    const secondDirectory = '/track/.authorized-pending-a';
    const firstFiles = Array.from({ length: 51 }, (_, i) => `batch-100-${2 * i + 1}.log`);
    const secondFiles = Array.from({ length: 51 }, (_, i) => `batch-100-${2 * i + 2}.log`);
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([...firstFiles, 'batch-0.tmp', 'unrelated.txt'] as never)
      .mockResolvedValueOnce(secondFiles as never);

    await evictBatchFiles([firstDirectory, secondDirectory]);

    expect(vi.mocked(fs.unlink).mock.calls).toEqual([
      [`${firstDirectory}/batch-100-1.log`],
      [`${secondDirectory}/batch-100-2.log`],
    ]);
  });

  it('retains directory order when batch filenames are identical', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['batch-100-1.log'] as never);

    await evictBatchFiles(['/track/pending-z', '/track/pending-a'], 1);

    expect(fs.unlink).toHaveBeenCalledExactlyOnceWith('/track/pending-z/batch-100-1.log');
  });

  it('continues eviction after directory reads or individual deletions fail', async () => {
    vi.mocked(fs.readdir)
      .mockRejectedValueOnce(Object.assign(new Error('missing directory'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(['batch-1.log', 'batch-2.log', 'batch-3.log'] as never);
    vi.mocked(fs.unlink).mockRejectedValueOnce(Object.assign(new Error('file locked'), { code: 'EPERM' }));

    await expect(evictBatchFiles(['/missing', '/readable'], 1)).resolves.toBeUndefined();

    expect(vi.mocked(fs.unlink).mock.calls).toEqual([['/readable/batch-1.log'], ['/readable/batch-2.log']]);
  });
});
