import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackingConsentManager, type TrackingConsent } from '../../domain/tracking-consent';
import { EventKind, EventTrack, type ServerEvent } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import { BatchManager } from './BatchManager';
import type { BatchConfig } from './batchConfig.types';

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

  const logFiles = async (directory: string) =>
    (await fs.readdir(directory).catch(() => [] as string[])).filter((file) => file.endsWith('.log'));

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

    manager.post(input as unknown as ServerEvent);
    await manager.flush();

    expect(await logFiles(path.join(basePath, directory))).toEqual([]);
    expect(await logFiles(path.join(basePath, directory, 'pending'))).toHaveLength(1);

    state.update('granted');
    await manager.flush();

    expect(await logFiles(path.join(basePath, directory, 'pending'))).toEqual([]);
    expect(await logFiles(path.join(basePath, directory))).toHaveLength(1);
  });

  it('deletes accepted pending events when consent is rejected', async () => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(), state);

    manager.post(event('delete-me'));
    state.update('not-granted');
    await manager.flush();

    expect(await logFiles(path.join(basePath, 'rum', 'pending'))).toEqual([]);
    expect(await logFiles(path.join(basePath, 'rum'))).toEqual([]);
  });

  it.each(['flush', 'scheduled cycle'] as const)(
    'retries a rejected store deletion on %s without another consent transition',
    async (retry) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const state = createConsentManager('pending');
      manager = await BatchManager.create(config, createBatchConfig(), state);
      const authorizedPath = path.join(basePath, 'rum');
      const pendingPath = path.join(authorizedPath, 'pending');
      manager.post(event('rejected'));
      await manager.flush();
      const error = Object.assign(new Error('directory busy'), { code: 'EPERM' });
      const remove = vi.spyOn(fs, 'rm').mockRejectedValue(error);

      state.update('not-granted');
      await expect(manager.flush()).rejects.toBe(error);
      expect(await storedValues(pendingPath)).toEqual(['rejected']);

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
      expect(await storedValues(authorizedPath)).toEqual([]);
    }
  );

  it('keeps a new pending interval intact while a rejected store cleanup is retried', async () => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(), state);
    const authorizedPath = path.join(basePath, 'rum');
    const pendingPath = path.join(authorizedPath, 'pending');
    manager.post(event('rejected'));
    await manager.flush();
    const error = Object.assign(new Error('directory busy'), { code: 'EPERM' });
    const originalRemove = fs.rm.bind(fs);
    const remove = vi.spyOn(fs, 'rm').mockRejectedValue(error);
    state.update('not-granted');
    await expect(manager.flush()).rejects.toBe(error);

    let notifyStarted!: () => void;
    let resumeCleanup!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeCleanup = resolve;
    });
    remove
      .mockImplementationOnce(async (...args) => {
        notifyStarted();
        await resume;
        await originalRemove(...args);
      })
      .mockImplementation(originalRemove);
    const recovery = manager.flush();
    await started;
    state.update('pending');
    manager.post(event('accepted'));
    state.update('granted');
    resumeCleanup();
    await recovery;
    await manager.flush();

    expect(await storedValues(pendingPath)).toEqual([]);
    expect(await storedValues(authorizedPath)).toEqual(['accepted']);
  });

  it('recovers accepted files before clearing a later quarantined interval', async () => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(), state);
    const authorizedPath = path.join(basePath, 'rum');
    const pendingPath = path.join(authorizedPath, 'pending');
    manager.post(event('accepted'));
    await manager.flush();
    const rename = fs.rename.bind(fs);
    const error = Object.assign(new Error('directory busy'), { code: 'EPERM' });
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (source === pendingPath) throw error;
      await rename(source, destination);
    });

    state.update('granted');
    state.update('pending');
    manager.post(event('quarantined'));
    state.update('granted');
    state.update('not-granted');
    state.update('pending');
    await expect(manager.flush()).rejects.toBe(error);
    expect(await storedValues(pendingPath)).toEqual(['accepted']);

    renameSpy.mockRestore();
    await manager.flush();
    expect(await storedValues(authorizedPath)).toEqual(['accepted']);
    expect(await storedValues(pendingPath)).toEqual([]);
  });

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
    expect(await logFiles(path.join(basePath, 'rum', 'pending'))).toEqual([]);
  });

  it('does not persist events while consent is not granted', async () => {
    const state = createConsentManager('not-granted');
    manager = await BatchManager.create(config, createBatchConfig(), state);

    manager.post(event('drop-me'));
    await manager.flush();

    expect(await logFiles(path.join(basePath, 'rum', 'pending'))).toEqual([]);
    expect(await logFiles(path.join(basePath, 'rum'))).toEqual([]);
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
    expect(await logFiles(path.join(authorizedPath, 'pending'))).toEqual([]);
  });

  it('bounds the authorized backlog after repeated pending grants without direct granted writes', async () => {
    const state = createConsentManager('pending');
    manager = await BatchManager.create(config, createBatchConfig(EventTrack.REPLAY), state);
    const authorizedPath = path.join(basePath, 'replay');

    for (let interval = 0; interval < 2; interval++) {
      state.update('pending');
      for (let index = 0; index < 60; index++) {
        manager.post({
          kind: EventKind.SERVER,
          track: EventTrack.REPLAY,
          data: {
            metadata: { start: interval * 60 + index },
            rawBytesCount: 1,
            compressed: Buffer.from([1]),
          },
        } as unknown as ServerEvent);
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

  it('deletes pending storage for every known track before managers are selected', async () => {
    const trackDirectories = ['rum', 'spans', 'dd_logs', 'profile', 'replay'];
    for (const directory of trackDirectories) {
      const pendingPath = path.join(basePath, directory, 'pending');
      await fs.mkdir(pendingPath, { recursive: true });
      await fs.writeFile(path.join(pendingPath, 'stale.log'), 'stale');
    }

    await BatchManager.clearStalePendingData(basePath);

    for (const directory of trackDirectories) {
      expect(await logFiles(path.join(basePath, directory, 'pending'))).toEqual([]);
    }
  });
});
