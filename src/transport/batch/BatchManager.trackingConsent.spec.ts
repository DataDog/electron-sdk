import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrackingConsentState } from '../../domain/tracking-consent';
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
    mockConsumerUpload.mockClear();
  });

  afterEach(async () => {
    manager?.stop();
    manager = undefined;
    await fs.rm(basePath, { recursive: true, force: true });
  });

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
    const state = createTrackingConsentState('pending');
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
    const state = createTrackingConsentState('pending');
    manager = await BatchManager.create(config, createBatchConfig(), state);

    manager.post(event('delete-me'));
    state.update('not-granted');
    await manager.flush();

    expect(await logFiles(path.join(basePath, 'rum', 'pending'))).toEqual([]);
    expect(await logFiles(path.join(basePath, 'rum'))).toEqual([]);
  });

  it('preserves transition order when consent changes repeatedly without waiting', async () => {
    const state = createTrackingConsentState('pending');
    manager = await BatchManager.create(config, createBatchConfig(), state);

    manager.post(event('authorize-me'));
    state.update('granted');
    state.update('pending');
    await manager.flush();

    expect(await logFiles(path.join(basePath, 'rum'))).toHaveLength(1);
    expect(await logFiles(path.join(basePath, 'rum', 'pending'))).toEqual([]);
  });

  it('keeps only events accepted by rapid ordered consent transitions', async () => {
    const state = createTrackingConsentState('pending');
    manager = await BatchManager.create(config, createBatchConfig(), state);

    for (let i = 0; i < 25; i++) {
      manager.post(event(`first-pending-${i}`));
    }
    state.update('granted');
    for (let i = 0; i < 25; i++) {
      manager.post(event(`granted-${i}`));
    }
    state.update('pending');
    for (let i = 0; i < 25; i++) {
      manager.post(event(`rejected-pending-${i}`));
    }
    state.update('not-granted');
    for (let i = 0; i < 25; i++) {
      manager.post(event(`not-granted-${i}`));
    }
    state.update('pending');
    for (let i = 0; i < 25; i++) {
      manager.post(event(`second-pending-${i}`));
    }
    state.update('granted');

    await manager.flush();

    const values = await storedValues(path.join(basePath, 'rum'));
    expect(values.filter((value) => value.startsWith('first-pending-'))).toHaveLength(25);
    expect(values.filter((value) => value.startsWith('granted-'))).toHaveLength(25);
    expect(values.filter((value) => value.startsWith('second-pending-'))).toHaveLength(25);
    expect(values.some((value) => value.startsWith('rejected-pending-'))).toBe(false);
    expect(values.some((value) => value.startsWith('not-granted-'))).toBe(false);
    expect(await logFiles(path.join(basePath, 'rum', 'pending'))).toEqual([]);
  });

  it('does not persist events while consent is not granted', async () => {
    const state = createTrackingConsentState('not-granted');
    manager = await BatchManager.create(config, createBatchConfig(), state);

    manager.post(event('drop-me'));
    await manager.flush();

    expect(await logFiles(path.join(basePath, 'rum', 'pending'))).toEqual([]);
    expect(await logFiles(path.join(basePath, 'rum'))).toEqual([]);
  });

  it('deletes pending storage left by a previous process at startup', async () => {
    const pendingPath = path.join(basePath, 'rum', 'pending');
    await fs.mkdir(pendingPath, { recursive: true });
    await fs.writeFile(path.join(pendingPath, 'stale.log'), 'stale');

    manager = await BatchManager.create(config, createBatchConfig(), createTrackingConsentState('pending'));

    expect(await logFiles(pendingPath)).toEqual([]);
  });
});
