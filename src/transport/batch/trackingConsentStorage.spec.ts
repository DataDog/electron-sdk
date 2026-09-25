import { generateUUID } from '@datadog/browser-core';
import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizePendingBatches,
  clearBatchDirectory,
  recoverAuthorizedPendingBatches,
} from './trackingConsentStorage';

vi.mock('node:fs/promises');
vi.mock('@datadog/browser-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@datadog/browser-core')>()),
  generateUUID: vi.fn(),
}));

describe('tracking consent storage', () => {
  const pendingPath = '/data/rum/pending';
  const authorizedPath = '/data/rum';
  const stagingPath = '/data/rum/.authorized-pending-migration-id';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateUUID).mockReturnValue('migration-id');
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.rename).mockResolvedValue(undefined);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([]);
  });

  it('clears rejected pending storage recursively and propagates deletion failures', async () => {
    await clearBatchDirectory(pendingPath);

    expect(fs.rm).toHaveBeenCalledWith(pendingPath, { recursive: true, force: true });

    const error = new Error('permission denied');
    vi.mocked(fs.rm).mockRejectedValueOnce(error);
    await expect(clearBatchDirectory(pendingPath)).rejects.toBe(error);
  });

  it('detaches the pending directory before moving complete log and tmp batches', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([{ name: '.authorized-pending-migration-id', isDirectory: () => true }] as never)
      .mockResolvedValueOnce(['batch-1.log', 'batch-2.tmp'] as never);

    await authorizePendingBatches(pendingPath, authorizedPath);

    expect(fs.mkdir).toHaveBeenCalledWith(authorizedPath, { recursive: true });
    expect(vi.mocked(fs.rename).mock.calls).toEqual([
      [pendingPath, stagingPath],
      [`${stagingPath}/batch-1.log`, `${authorizedPath}/batch-1.log-pending-migration-id.log`],
      [`${stagingPath}/batch-2.tmp`, `${authorizedPath}/batch-2.tmp-pending-migration-id.log`],
    ]);
    expect(fs.rm).toHaveBeenCalledWith(stagingPath, { recursive: true, force: true });
  });

  it('does not overwrite an authorized batch with the same producer filename', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([
        { name: 'batch-1.log', isDirectory: () => false },
        { name: '.authorized-pending-migration-id', isDirectory: () => true },
      ] as never)
      .mockResolvedValueOnce(['batch-1.log'] as never);

    await authorizePendingBatches(pendingPath, authorizedPath);

    expect(fs.rename).toHaveBeenLastCalledWith(
      `${stagingPath}/batch-1.log`,
      `${authorizedPath}/batch-1.log-pending-migration-id.log`
    );
    expect(fs.access).not.toHaveBeenCalled();
  });

  it('keeps unmoved files after a partial failure and retries without overwriting migrated files', async () => {
    const error = new Error('busy');
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([{ name: '.authorized-pending-migration-id', isDirectory: () => true }] as never)
      .mockResolvedValueOnce(['batch-1.log', 'batch-1.tmp'] as never);
    vi.mocked(fs.rename).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);

    await expect(authorizePendingBatches(pendingPath, authorizedPath)).rejects.toBe(error);

    expect(fs.rm).not.toHaveBeenCalled();
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([
        { name: '.authorized-pending-migration-id', isDirectory: () => true },
        { name: 'batch-1.log-pending-migration-id.log', isDirectory: () => false },
      ] as never)
      .mockResolvedValueOnce(['batch-1.tmp'] as never);

    await recoverAuthorizedPendingBatches(authorizedPath);

    expect(fs.rename).toHaveBeenLastCalledWith(
      `${stagingPath}/batch-1.tmp`,
      `${authorizedPath}/batch-1.tmp-pending-migration-id.log`
    );
    expect(fs.rm).toHaveBeenCalledWith(stagingPath, { recursive: true, force: true });
  });

  it('leaves the pending directory untouched if atomic detachment fails', async () => {
    const error = Object.assign(new Error('busy'), { code: 'EPERM' });
    vi.mocked(fs.rename).mockRejectedValueOnce(error);

    await expect(authorizePendingBatches(pendingPath, authorizedPath)).rejects.toBe(error);

    expect(fs.rename).toHaveBeenCalledExactlyOnceWith(pendingPath, stagingPath);
    expect(fs.readdir).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('recovers authorized storage even if the active pending directory is missing', async () => {
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([{ name: '.authorized-pending-previous', isDirectory: () => true }] as never)
      .mockResolvedValueOnce(['batch-1.log'] as never);

    await authorizePendingBatches(pendingPath, authorizedPath);

    expect(fs.rename).toHaveBeenLastCalledWith(
      `${authorizedPath}/.authorized-pending-previous/batch-1.log`,
      `${authorizedPath}/batch-1.log-pending-previous.log`
    );
  });

  it('does nothing when neither pending nor detached storage exists', async () => {
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    await authorizePendingBatches(pendingPath, authorizedPath);

    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('recovers only detached directories, ignoring active pending and unrelated files', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([
        { name: '.authorized-pending-previous', isDirectory: () => true },
        { name: 'pending', isDirectory: () => true },
        { name: 'unrelated', isDirectory: () => true },
        { name: '.authorized-pending-not-a-directory', isDirectory: () => false },
      ] as never)
      .mockResolvedValueOnce(['batch-1.log', 'unrelated.txt'] as never);

    await recoverAuthorizedPendingBatches(authorizedPath);

    expect(fs.readdir).toHaveBeenCalledTimes(2);
    expect(fs.rename).toHaveBeenCalledExactlyOnceWith(
      `${authorizedPath}/.authorized-pending-previous/batch-1.log`,
      `${authorizedPath}/batch-1.log-pending-previous.log`
    );
    expect(fs.rm).toHaveBeenCalledExactlyOnceWith(`${authorizedPath}/.authorized-pending-previous`, {
      recursive: true,
      force: true,
    });
  });

  it('ignores a missing authorized directory but propagates other read failures', async () => {
    vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    await expect(recoverAuthorizedPendingBatches(authorizedPath)).resolves.toBeUndefined();

    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(fs.readdir).mockRejectedValueOnce(error);
    await expect(recoverAuthorizedPendingBatches(authorizedPath)).rejects.toBe(error);
  });
});
