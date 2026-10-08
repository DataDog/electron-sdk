import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackingConsentManager, type TrackingConsent } from '../../domain/tracking-consent';
import { EventKind, EventTrack, type ServerEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import { BatchManager } from './BatchManager';
import type { BatchConfig } from './batchConfig.types';
import { PENDING_DIRECTORY_PREFIX } from './batchPaths';

const { mockConsumerUpload } = vi.hoisted(() => ({
  mockConsumerUpload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./standard/StandardBatchConsumer', () => ({
  StandardBatchConsumer: vi.fn().mockImplementation(function (this: unknown) {
    return { upload: mockConsumerUpload };
  }),
}));

vi.mock('./profiling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./profiling')>();
  return {
    ...actual,
    ProfileBatchConsumer: vi.fn().mockImplementation(function (this: unknown) {
      return { upload: mockConsumerUpload };
    }),
  };
});

vi.mock('./replay/ReplayBatchConsumer', () => ({
  ReplayBatchConsumer: vi.fn().mockImplementation(function (this: unknown) {
    return { upload: mockConsumerUpload };
  }),
}));

vi.mock('../utils', () => ({
  computeIntakeUrlForTrack: vi.fn(() => 'https://mock-intake.com/api/v2/rum'),
}));

describe('BatchManager tracking consent storage', () => {
  let basePath: string;
  let manager: BatchManager | undefined;
  const config = createTestConfiguration();

  beforeEach(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-sdk-consent-'));
    mockConsumerUpload.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    manager?.stop();
    manager = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fs.rm(basePath, { recursive: true, force: true });
  });

  const createConsentManager = (consent: TrackingConsent) => {
    const state = new TrackingConsentManager();
    state.update(consent);
    return state;
  };

  const createBatchConfig = (trackType: EventTrack = EventTrack.RUM): BatchConfig => ({
    path: basePath,
    trackType,
    batchSize: 1024,
    uploadFrequency: 60_000,
  });

  const event = (value: string) =>
    ({ kind: EventKind.SERVER, track: EventTrack.RUM, data: { value } }) as unknown as ServerEvent;

  const replayEvent = (start: number) =>
    ({
      kind: EventKind.SERVER,
      track: EventTrack.REPLAY,
      data: { metadata: { start }, rawBytesCount: 1, compressed: Buffer.from([1]) },
    }) as unknown as ServerEvent;

  const logFiles = async (directory: string) =>
    (await fs.readdir(directory).catch(() => [] as string[])).filter((file) => file.endsWith('.log'));

  const pendingDirectories = async (directory: string) =>
    (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(PENDING_DIRECTORY_PREFIX))
      .map((entry) => path.join(directory, entry.name));

  const storedValues = async (directory: string) => {
    const values: string[] = [];
    for (const file of await logFiles(directory)) {
      const lines = (await fs.readFile(path.join(directory, file), 'utf8')).trim().split('\n');
      values.push(...lines.map((line) => (JSON.parse(line) as { value: string }).value));
    }
    return values;
  };

  it.each([
    [EventTrack.RUM, event('rum')],
    [EventTrack.LOGS, { kind: EventKind.SERVER, track: EventTrack.LOGS, data: { message: 'log' } }],
    [EventTrack.SPANS, { kind: EventKind.SERVER, track: EventTrack.SPANS, data: { name: 'span' } }],
    [
      EventTrack.PROFILE,
      { kind: EventKind.SERVER, track: EventTrack.PROFILE, data: { family: 'chrome' }, trace: { resources: [] } },
    ],
    [
      EventTrack.REPLAY,
      {
        kind: EventKind.SERVER,
        track: EventTrack.REPLAY,
        data: { metadata: { start: 1 }, rawBytesCount: 1, compressed: Buffer.from([1]) },
      },
    ],
  ] as const)('isolates pending %s events and moves them to authorized storage after grant', async (track, input) => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(track), state);
    const directory = track === EventTrack.LOGS ? 'dd_logs' : track;
    const authorizedPath = path.join(basePath, directory);

    manager.post(input as unknown as ServerEvent);
    await manager.flush();

    expect(await logFiles(authorizedPath)).toEqual([]);
    const pendingPaths = await pendingDirectories(authorizedPath);
    expect(pendingPaths).toHaveLength(1);
    expect(await logFiles(pendingPaths[0])).toHaveLength(1);

    state.update('granted');
    await manager.flush();

    expect(await pendingDirectories(authorizedPath)).toEqual([]);
    expect(await logFiles(authorizedPath)).toHaveLength(1);
  });

  it.each(['pending', 'not-granted'] as const)(
    'uploads an authorized recovered crash while current consent is %s',
    async (consent) => {
      const state = createConsentManager(consent);
      manager = await BatchManager.create(config, createBatchConfig(), state);
      const authorizedPath = path.join(basePath, 'rum');
      const uploaded: string[] = [];
      mockConsumerUpload.mockImplementation(async () => {
        uploaded.push(...(await storedValues(authorizedPath)));
      });

      manager.post({ ...event('recovered-crash'), storageConsent: 'granted' } as ServerEvent);
      manager.post(event('current-event'));
      state.update('not-granted');
      await manager.flush();

      expect(uploaded).toEqual(['recovered-crash']);
      expect(await pendingDirectories(authorizedPath)).toEqual([]);
      for (const file of await logFiles(authorizedPath)) {
        expect(await fs.readFile(path.join(authorizedPath, file), 'utf8')).not.toContain('storageConsent');
      }
    }
  );

  it('deletes pending events when consent is rejected', async () => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(), state);

    manager.post(event('delete-me'));
    state.update('not-granted');
    await manager.flush();

    expect(await pendingDirectories(path.join(basePath, 'rum'))).toEqual([]);
    expect(await logFiles(path.join(basePath, 'rum'))).toEqual([]);
  });

  it.each(['flush', 'scheduled cycle'] as const)(
    'retries a rejected store deletion on %s without another consent transition',
    async (retry) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const state = createConsentManager('granted');
      manager = await BatchManager.create(config, createBatchConfig(), state);
      const authorizedPath = path.join(basePath, 'rum');
      manager.post(event('authorized'));
      state.update('pending');
      manager.post(event('rejected'));
      await manager.flush();
      const [pendingPath] = await pendingDirectories(authorizedPath);
      const error = Object.assign(new Error('directory busy'), { code: 'EPERM' });
      const remove = vi.spyOn(fs, 'rm').mockRejectedValue(error);
      const uploaded: string[] = [];
      mockConsumerUpload.mockClear().mockImplementation(async () => {
        uploaded.push(...(await storedValues(authorizedPath)));
      });

      state.update('not-granted');
      await expect(manager.flush()).resolves.toBeUndefined();
      expect(await storedValues(pendingPath)).toEqual(['rejected']);
      expect(mockConsumerUpload).toHaveBeenCalledOnce();
      expect(uploaded).toEqual(['authorized']);

      remove.mockRestore();
      if (retry === 'flush') {
        await manager.flush();
      } else {
        await vi.advanceTimersByTimeAsync(createBatchConfig().uploadFrequency);
        await vi.waitFor(async () => {
          expect(await storedValues(pendingPath)).toEqual([]);
        });
      }

      expect(state.get()).toBe('not-granted');
      expect(await storedValues(pendingPath)).toEqual([]);
      expect(await storedValues(authorizedPath)).toEqual(['authorized']);
    }
  );

  it('writes and grants a new pending period while deletion of a rejected period keeps failing', async () => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(), state);
    const authorizedPath = path.join(basePath, 'rum');
    manager.post(event('rejected'));
    await manager.flush();
    const [rejectedPath] = await pendingDirectories(authorizedPath);
    const error = Object.assign(new Error('directory busy'), { code: 'EPERM' });
    const originalRemove = fs.rm.bind(fs);
    const remove = vi.spyOn(fs, 'rm').mockImplementation(async (directory, options) => {
      if (directory === rejectedPath) throw error;
      await originalRemove(directory, options);
    });
    state.update('not-granted');
    await manager.flush();

    state.update('pending');
    manager.post(event('accepted'));
    await manager.flush();
    const paths = await pendingDirectories(authorizedPath);
    expect(paths).toHaveLength(2);
    const acceptedPath = paths.find((directory) => directory !== rejectedPath)!;
    expect(await storedValues(acceptedPath)).toEqual(['accepted']);

    state.update('granted');
    mockConsumerUpload.mockClear();
    await manager.flush();

    expect(mockConsumerUpload).toHaveBeenCalledOnce();
    expect(await storedValues(rejectedPath)).toEqual(['rejected']);
    expect(await storedValues(authorizedPath)).toEqual(['accepted']);

    remove.mockRestore();
    await manager.flush();

    expect(await pendingDirectories(authorizedPath)).toEqual([]);
    expect(await storedValues(authorizedPath)).toEqual(['accepted']);
  });

  it.each(['granted', 'not-granted'] as const)(
    'keeps a new pending period independent when its decision is %s and an earlier grant cannot detach',
    async (decision) => {
      const state = createConsentManager('pending');
      manager = await BatchManager.create(config, createBatchConfig(), state);
      const authorizedPath = path.join(basePath, 'rum');
      manager.post(event('first'));
      await manager.flush();
      const [firstPath] = await pendingDirectories(authorizedPath);
      const rename = fs.rename.bind(fs);
      const error = Object.assign(new Error('directory busy'), { code: 'EPERM' });
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        if (source === firstPath) throw error;
        await rename(source, destination);
      });

      state.update('granted');
      manager.post(event('authorized'));
      mockConsumerUpload.mockClear();
      await expect(manager.flush()).resolves.toBeUndefined();
      expect(mockConsumerUpload).toHaveBeenCalledOnce();
      expect(await storedValues(authorizedPath)).toEqual(['authorized']);

      state.update('pending');
      manager.post(event('second'));
      await manager.flush();
      const paths = await pendingDirectories(authorizedPath);
      expect(paths).toHaveLength(2);
      const secondPath = paths.find((directory) => directory !== firstPath)!;
      expect(await storedValues(secondPath)).toEqual(['second']);

      state.update(decision);
      await manager.flush();
      expect(await storedValues(firstPath)).toEqual(['first']);
      expect(await storedValues(secondPath)).toEqual([]);
      expect((await storedValues(authorizedPath)).sort()).toEqual(
        decision === 'granted' ? ['authorized', 'second'] : ['authorized']
      );

      renameSpy.mockRestore();
      await manager.flush();
      expect((await storedValues(authorizedPath)).sort()).toEqual(
        decision === 'granted' ? ['authorized', 'first', 'second'] : ['authorized', 'first']
      );
      expect(await pendingDirectories(authorizedPath)).toEqual([]);
    }
  );

  it('keeps only events accepted by rapid ordered consent transitions', async () => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(), state);

    manager.post(event('first-pending'));
    state.update('granted');
    manager.post(event('granted'));
    state.update('pending');
    manager.post(event('rejected-pending'));
    state.update('not-granted');
    manager.post(event('not-granted'));
    state.update('pending');
    manager.post(event('second-pending'));
    state.update('granted');

    await manager.flush();

    const values = await storedValues(path.join(basePath, 'rum'));
    expect(values.sort()).toEqual(['first-pending', 'granted', 'second-pending']);
    expect(await pendingDirectories(path.join(basePath, 'rum'))).toEqual([]);
  });

  it('keeps decisions attached to their periods while pending directory creation is delayed', async () => {
    const state = createConsentManager('granted');
    manager = await BatchManager.create(config, createBatchConfig(), state);
    const mkdir = fs.mkdir.bind(fs);
    let pendingPath: string | undefined;
    let notifyStarted!: () => void;
    let resumeCreation!: () => void;
    const started = new Promise<void>((resolve) => (notifyStarted = resolve));
    const resumed = new Promise<void>((resolve) => (resumeCreation = resolve));
    vi.spyOn(fs, 'mkdir').mockImplementation(async (directory, options) => {
      if (
        pendingPath === undefined &&
        typeof directory === 'string' &&
        path.basename(directory).startsWith(PENDING_DIRECTORY_PREFIX)
      ) {
        pendingPath = directory;
        notifyStarted();
        await resumed;
      }
      return mkdir(directory, options);
    });

    state.update('pending');
    manager.post(event('accepted'));
    await started;
    state.update('granted');
    state.update('pending');
    manager.post(event('rejected'));
    state.update('not-granted');
    const flushed = manager.flush();
    resumeCreation();
    await flushed;

    expect(await storedValues(path.join(basePath, 'rum'))).toEqual(['accepted']);
    expect(await pendingDirectories(path.join(basePath, 'rum'))).toEqual([]);
  });

  it('continues authorized uploads and starts a fresh period after pending directory creation fails', async () => {
    const state = createConsentManager('granted');
    manager = await BatchManager.create(config, createBatchConfig(), state);
    const mkdir = fs.mkdir.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (directory, options) => {
      if (!failed && typeof directory === 'string' && path.basename(directory).startsWith(PENDING_DIRECTORY_PREFIX)) {
        failed = true;
        throw Object.assign(new Error('directory unavailable'), { code: 'EPERM' });
      }
      return mkdir(directory, options);
    });

    state.update('pending');
    manager.post(event('unwritten'));
    state.update('granted');
    manager.post(event('authorized'));
    await expect(manager.flush()).resolves.toBeUndefined();

    expect(mockConsumerUpload).toHaveBeenCalledOnce();
    expect(await storedValues(path.join(basePath, 'rum'))).toEqual(['authorized']);

    state.update('pending');
    manager.post(event('accepted'));
    state.update('granted');
    await manager.flush();

    expect((await storedValues(path.join(basePath, 'rum'))).sort()).toEqual(['accepted', 'authorized']);
    expect(await pendingDirectories(path.join(basePath, 'rum'))).toEqual([]);
  });

  it('does not persist events while consent is not granted', async () => {
    const state = createConsentManager('not-granted');
    manager = await BatchManager.create(config, createBatchConfig(), state);

    manager.post(event('drop-me'));
    await manager.flush();

    expect(await pendingDirectories(path.join(basePath, 'rum'))).toEqual([]);
    expect(await logFiles(path.join(basePath, 'rum'))).toEqual([]);
  });

  it('retries pending directory creation without requiring another consent transition', async () => {
    const state = createConsentManager('granted');
    manager = await BatchManager.create(config, createBatchConfig(), state);
    const mkdir = fs.mkdir.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (directory, options) => {
      if (!failed && typeof directory === 'string' && path.basename(directory).startsWith(PENDING_DIRECTORY_PREFIX)) {
        failed = true;
        throw Object.assign(new Error('directory unavailable'), { code: 'EPERM' });
      }
      return mkdir(directory, options);
    });

    state.update('pending');
    manager.post(event('unwritten'));
    await manager.flush();
    manager.post(event('accepted'));
    state.update('granted');
    await manager.flush();

    expect(await storedValues(path.join(basePath, 'rum'))).toEqual(['accepted']);
    expect(await pendingDirectories(path.join(basePath, 'rum'))).toEqual([]);
  });

  it('keeps already authorized batches uploadable after consent is denied', async () => {
    const state = createConsentManager('granted');
    manager = await BatchManager.create(config, createBatchConfig(), state);
    const authorizedPath = path.join(basePath, 'rum');
    const uploaded: string[] = [];
    mockConsumerUpload.mockImplementationOnce(async () => {
      uploaded.push(...(await storedValues(authorizedPath)));
      for (const file of await logFiles(authorizedPath)) {
        await fs.unlink(path.join(authorizedPath, file));
      }
    });

    manager.post(event('authorized'));
    state.update('not-granted');
    manager.post(event('rejected'));
    await manager.flush();

    expect(uploaded).toEqual(['authorized']);
    expect(await logFiles(authorizedPath)).toEqual([]);
    expect(await pendingDirectories(authorizedPath)).toEqual([]);
  });

  it('bounds the authorized backlog after repeated pending grants without direct granted writes', async () => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(EventTrack.REPLAY), state);
    const authorizedPath = path.join(basePath, 'replay');

    for (let period = 0; period < 2; period++) {
      state.update('pending');
      for (let index = 0; index < 60; index++) {
        manager.post(replayEvent(period * 60 + index));
      }
      state.update('granted');
      await manager.flush();
    }

    const files = await logFiles(authorizedPath);
    expect(files).toHaveLength(100);
    const retained = await Promise.all(
      files.map(async (file) => {
        const [metadata] = (await fs.readFile(path.join(authorizedPath, file), 'utf8')).split('\n');
        return (JSON.parse(metadata) as { start: number }).start;
      })
    );
    expect(retained.sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, index) => index + 20));
  });

  it('bounds the combined backlog across pending periods whose grants cannot detach', async () => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(EventTrack.REPLAY), state);
    const authorizedPath = path.join(basePath, 'replay');
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (
        typeof source === 'string' &&
        path.dirname(source) === authorizedPath &&
        path.basename(source).startsWith(PENDING_DIRECTORY_PREFIX)
      ) {
        throw Object.assign(new Error('directory busy'), { code: 'EPERM' });
      }
      await rename(source, destination);
    });

    for (let period = 0; period < 2; period++) {
      state.update('pending');
      for (let index = 0; index < 60; index++) {
        manager.post(replayEvent(period * 60 + index));
      }
      state.update('granted');
      await manager.flush();
    }

    const pendingPaths = await pendingDirectories(authorizedPath);
    expect(pendingPaths).toHaveLength(2);
    const files = (
      await Promise.all(
        pendingPaths.map(async (directory) => (await logFiles(directory)).map((file) => path.join(directory, file)))
      )
    ).flat();
    expect(files).toHaveLength(100);
    const retained = await Promise.all(
      files.map(async (file) => {
        const [metadata] = (await fs.readFile(file, 'utf8')).split('\n');
        return (JSON.parse(metadata) as { start: number }).start;
      })
    );
    expect(retained.sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, index) => index + 20));
  });
});
