import { generateUUID } from '@datadog/browser-core';
import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { display } from '../../tools/display';
import { BatchMigration, type PendingBatchStore } from './BatchMigration';
import type { BatchProducer } from './BatchProducer';
import { evictBatchFiles } from './batchFileEviction';

vi.mock('node:fs/promises');
vi.mock('../../domain/telemetry', () => ({ monitor: <T>(callback: T): T => callback }));
vi.mock('../../tools/display', () => ({ display: { error: vi.fn() } }));
vi.mock('./batchFileEviction', () => ({ evictBatchFiles: vi.fn() }));
vi.mock('@datadog/browser-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@datadog/browser-core')>()),
  generateUUID: vi.fn(),
}));

const authorizedPath = '/data/rum';
const pendingPath = '/data/rum/pending-period-1';
const stagingPath = '/data/rum/.authorized-pending-migration-id';
const missingPath = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const directory = (name: string) => ({ name, isDirectory: () => true });

function createStore(storePath = pendingPath) {
  const flush = vi.fn<BatchProducer['flush']>().mockResolvedValue(undefined);
  const store: PendingBatchStore = {
    path: storePath,
    producer: Promise.resolve({ flush } as unknown as BatchProducer),
  };
  return { store, flush };
}

describe('BatchMigration', () => {
  let migration: BatchMigration;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateUUID).mockReturnValue('migration-id');
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.rename).mockResolvedValue(undefined);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([]);
    vi.mocked(evictBatchFiles).mockResolvedValue(undefined);
    migration = new BatchMigration(authorizedPath);
  });

  it('seals pending writes before detaching and preserves distinct log and tmp batch names', async () => {
    const { store, flush } = createStore();
    let finishFlush!: () => void;
    flush.mockReturnValue(
      new Promise<void>((resolve) => {
        finishFlush = resolve;
      })
    );
    vi.mocked(fs.readdir).mockImplementation((directoryPath) =>
      Promise.resolve(directoryPath === stagingPath ? (['batch-1.log', 'batch-1.tmp'] as never) : [])
    );

    migration.authorize(store);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(fs.rename).not.toHaveBeenCalled();
    finishFlush();
    await migration.flush();

    expect(vi.mocked(fs.rename).mock.calls).toEqual([
      [pendingPath, stagingPath],
      [`${stagingPath}/batch-1.log`, `${authorizedPath}/batch-1.log-pending-migration-id.log`],
      [`${stagingPath}/batch-1.tmp`, `${authorizedPath}/batch-1.tmp-pending-migration-id.log`],
    ]);
    expect(fs.rm).toHaveBeenCalledWith(stagingPath, { recursive: true, force: true });
    expect(fs.access).not.toHaveBeenCalled();
  });

  it('retains a partial migration and retries only files that have not moved', async () => {
    const { store } = createStore();
    const error = new Error('busy');
    let detached = false;
    let failMove = true;
    let files = ['batch-1.log', 'batch-1.tmp'];
    vi.mocked(fs.readdir).mockImplementation((directoryPath) =>
      Promise.resolve(directoryPath === stagingPath ? ([...files] as never) : [])
    );
    vi.mocked(fs.rename).mockImplementation((source) => {
      if (source === pendingPath) {
        if (detached) return Promise.reject(missingPath());
        detached = true;
      } else if (source === `${stagingPath}/batch-1.tmp` && failMove) {
        return Promise.reject(error);
      } else {
        files = files.filter((file) => `${stagingPath}/${file}` !== source);
      }
      return Promise.resolve();
    });

    migration.authorize(store);
    await vi.waitFor(() => expect(display.error).toHaveBeenCalledWith('Failed to migrate pending batches', error));
    expect(fs.rm).not.toHaveBeenCalled();

    failMove = false;
    await migration.flush();

    expect(vi.mocked(fs.rename).mock.calls.filter(([source]) => source === `${stagingPath}/batch-1.log`)).toHaveLength(
      1
    );
    expect(fs.rename).toHaveBeenLastCalledWith(
      `${stagingPath}/batch-1.tmp`,
      `${authorizedPath}/batch-1.tmp-pending-migration-id.log`
    );
    expect(fs.rm).toHaveBeenCalledWith(stagingPath, { recursive: true, force: true });
  });

  it('retries failed detachment without deleting authorized files when a later period is rejected', async () => {
    const { store } = createStore();
    const next = createStore('/data/rum/pending-period-2');
    const error = Object.assign(new Error('busy'), { code: 'EPERM' });
    vi.mocked(fs.rename).mockRejectedValueOnce(error);

    migration.authorize(store);
    await vi.waitFor(() => expect(display.error).toHaveBeenCalledWith('Failed to migrate pending batches', error));
    migration.discard(next.store);
    await migration.flush();

    expect(fs.rename).toHaveBeenCalledWith(pendingPath, stagingPath);
    expect(fs.rm).toHaveBeenCalledWith(next.store.path, { recursive: true, force: true });
    expect(fs.rm).not.toHaveBeenCalledWith(pendingPath, expect.anything());
    expect(fs.rm).toHaveBeenCalledWith(stagingPath, { recursive: true, force: true });
  });

  it('keeps failed rejection retryable and cannot authorize it through a later decision', async () => {
    const rejected = createStore();
    const authorized = createStore('/data/rum/pending-period-2');
    const error = Object.assign(new Error('busy'), { code: 'EPERM' });
    let failDelete = true;
    vi.mocked(fs.rm).mockImplementation((directoryPath) => {
      if (directoryPath === pendingPath && failDelete) return Promise.reject(error);
      return Promise.resolve();
    });

    migration.discard(rejected.store);
    await vi.waitFor(() => expect(display.error).toHaveBeenCalledWith('Failed to migrate pending batches', error));
    migration.authorize(rejected.store);
    migration.authorize(authorized.store);
    await expect(migration.flush()).resolves.toBeUndefined();

    expect(fs.rename).not.toHaveBeenCalledWith(pendingPath, expect.anything());
    expect(fs.rename).toHaveBeenCalledWith(authorized.store.path, stagingPath);

    failDelete = false;
    await migration.flush();
    const attempts = vi.mocked(fs.rm).mock.calls.filter(([directoryPath]) => directoryPath === pendingPath).length;
    await migration.flush();
    expect(vi.mocked(fs.rm).mock.calls.filter(([directoryPath]) => directoryPath === pendingPath)).toHaveLength(
      attempts
    );
  });

  it('waits for failed producer sealing to recover before migrating its files', async () => {
    const { store, flush } = createStore();
    const error = new Error('flush failed');
    flush.mockRejectedValueOnce(error);

    migration.authorize(store);
    await vi.waitFor(() => expect(display.error).toHaveBeenCalledWith('Failed to migrate pending batches', error));
    expect(fs.rename).not.toHaveBeenCalled();

    await migration.flush();

    expect(fs.rename).toHaveBeenCalledWith(pendingPath, stagingPath);
  });

  it('cleans up a period whose producer could not be created', async () => {
    migration.discard({ path: pendingPath, producer: Promise.resolve(undefined) });

    await migration.flush();

    expect(fs.rm).toHaveBeenCalledExactlyOnceWith(pendingPath, { recursive: true, force: true });
  });

  it('recovers only authorized directories left by an earlier process', async () => {
    vi.mocked(fs.readdir).mockImplementation((directoryPath) => {
      if (directoryPath === authorizedPath) {
        return Promise.resolve([
          directory('.authorized-pending-previous'),
          directory('pending-period'),
          directory('unrelated'),
          { name: '.authorized-pending-file', isDirectory: () => false },
        ] as never);
      }
      return Promise.resolve(['batch-1.log', 'batch-1.tmp', 'unrelated.txt'] as never);
    });

    await migration.flush();

    expect(vi.mocked(fs.rename).mock.calls).toEqual([
      [
        `${authorizedPath}/.authorized-pending-previous/batch-1.log`,
        `${authorizedPath}/batch-1.log-pending-previous.log`,
      ],
      [
        `${authorizedPath}/.authorized-pending-previous/batch-1.tmp`,
        `${authorizedPath}/batch-1.tmp-pending-previous.log`,
      ],
    ]);
    expect(fs.rm).toHaveBeenCalledExactlyOnceWith(`${authorizedPath}/.authorized-pending-previous`, {
      recursive: true,
      force: true,
    });
  });

  it('continues recovering other authorized periods when one move fails', async () => {
    const error = new Error('busy');
    vi.mocked(fs.readdir).mockImplementation((directoryPath) =>
      Promise.resolve(
        directoryPath === authorizedPath
          ? ([directory('.authorized-pending-first'), directory('.authorized-pending-second')] as never)
          : (['batch.log'] as never)
      )
    );
    vi.mocked(fs.rename).mockRejectedValueOnce(error);

    await expect(migration.flush()).resolves.toBeUndefined();

    expect(display.error).toHaveBeenCalledWith('Failed to recover authorized batches', error);
    expect(fs.rm).not.toHaveBeenCalledWith(`${authorizedPath}/.authorized-pending-first`, expect.anything());
    expect(fs.rename).toHaveBeenLastCalledWith(
      `${authorizedPath}/.authorized-pending-second/batch.log`,
      `${authorizedPath}/batch.log-pending-second.log`
    );
  });

  it('serializes concurrent recovery calls so a staged batch is moved only once', async () => {
    let remaining = true;
    let finishMove!: () => void;
    vi.mocked(fs.readdir).mockImplementation((directoryPath) =>
      Promise.resolve(
        directoryPath === authorizedPath
          ? ((remaining ? [directory('.authorized-pending-migration-id')] : []) as never)
          : (['batch.log'] as never)
      )
    );
    vi.mocked(fs.rename).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishMove = resolve;
      })
    );
    vi.mocked(fs.rm).mockImplementation(() => {
      remaining = false;
      return Promise.resolve();
    });

    const first = migration.flush();
    await vi.waitFor(() => expect(fs.rename).toHaveBeenCalledOnce());
    const second = migration.flush();
    finishMove();
    await Promise.all([first, second]);

    expect(fs.rename).toHaveBeenCalledOnce();
  });

  it('bounds pending and detached stores together without including authorized or unrelated directories', async () => {
    vi.mocked(fs.readdir).mockImplementation((directoryPath) => {
      if (directoryPath !== authorizedPath) return Promise.reject(new Error('busy'));
      return Promise.resolve([
        directory('pending-one'),
        directory('pending-two'),
        directory('.authorized-pending-previous'),
        directory('unrelated'),
        { name: 'pending-file', isDirectory: () => false },
      ] as never);
    });

    await migration.flush();

    expect(evictBatchFiles).toHaveBeenCalledExactlyOnceWith([
      '/data/rum/pending-one',
      '/data/rum/pending-two',
      '/data/rum/.authorized-pending-previous',
    ]);
  });

  it('reports directory inspection errors without blocking an upload cycle', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(fs.readdir).mockRejectedValueOnce(error);

    await expect(migration.flush()).resolves.toBeUndefined();

    expect(display.error).toHaveBeenCalledWith('Failed to manage pending batches', error);
  });

  describe('startup cleanup', () => {
    it('clears all pending periods and the legacy directory while preserving authorized and unrelated data', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        directory('pending'),
        directory('pending-period'),
        directory('.authorized-pending-previous'),
        directory('pendingish'),
        directory('unrelated'),
        { name: 'pending-file', isDirectory: () => false },
      ] as never);

      await BatchMigration.clearPendingData(authorizedPath);

      expect(vi.mocked(fs.rm).mock.calls).toEqual([
        [`${authorizedPath}/pending`, { recursive: true, force: true }],
        [`${authorizedPath}/pending-period`, { recursive: true, force: true }],
      ]);
    });

    it('ignores a missing track but propagates read and delete failures', async () => {
      vi.mocked(fs.readdir).mockRejectedValueOnce(missingPath());
      await expect(BatchMigration.clearPendingData(authorizedPath)).resolves.toBeUndefined();

      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      vi.mocked(fs.readdir).mockRejectedValueOnce(error);
      await expect(BatchMigration.clearPendingData(authorizedPath)).rejects.toBe(error);

      vi.mocked(fs.readdir).mockResolvedValueOnce([directory('pending-period')] as never);
      vi.mocked(fs.rm).mockRejectedValueOnce(error);
      await expect(BatchMigration.clearPendingData(authorizedPath)).rejects.toBe(error);
    });
  });
});
