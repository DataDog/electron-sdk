import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TimeStamp } from '@datadog/js-core/time';
import { EventManager } from '../../event';
import { createFormatHooks } from '../../assembly';
import { createTestConfiguration } from '../../mocks.specUtil';
import { TrackingConsentManager, type TrackingConsent } from '../tracking-consent';
import { Transport } from '../../transport';
import { FlagsState } from './FlagsState';
import { startEvaluationAggregator } from './EvaluationAggregator';

const { userData } = vi.hoisted(() => ({ userData: { path: '' } }));

vi.mock('electron', () => ({ app: { getPath: () => userData.path } }));

vi.mock('../../transport/batch/standard/StandardBatchConsumer', () => ({
  StandardBatchConsumer: vi.fn().mockImplementation(function (this: unknown) {
    return { upload: vi.fn().mockResolvedValue(undefined) };
  }),
}));

/** Batch storage keeps undecided-consent events in sibling directories with this prefix. */
const PENDING_DIRECTORY_PREFIX = 'pending-';

async function readLogs(directory: string): Promise<string[]> {
  const files = (await fs.readdir(directory).catch(() => [] as string[])).filter((file) => file.endsWith('.log'));
  return Promise.all(files.map((file) => fs.readFile(path.join(directory, file), 'utf8')));
}

async function readPendingLogs(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const contents: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(PENDING_DIRECTORY_PREFIX)) {
      contents.push(...(await readLogs(path.join(directory, entry.name))));
    }
  }
  return contents;
}

/** Real FlagsState → real aggregator → EventManager → real Transport and batch storage on disk. */
async function setup(consent: TrackingConsent) {
  const configuration = createTestConfiguration({
    profilingSampleRate: 0,
    sessionReplaySampleRate: 0,
    featureFlags: {
      env: 'e2e',
      refreshInterval: 0,
      fetchTimeout: 500,
      persistConfiguration: false,
      enableExposureLogging: false,
      enableRumFeatureFlagTracking: false,
      enableFlagEvaluationTracking: true,
    } as never,
  });
  const eventManager = new EventManager();
  const consentManager = await TrackingConsentManager.init(createFormatHooks());
  consentManager.update(consent);
  const transport = await Transport.create(configuration, eventManager, consentManager);
  const state = new FlagsState({ targetingKey: 'user-pro', plan: 'pro' });
  const aggregator = startEvaluationAggregator(
    state,
    { service: 'svc', applicationId: 'app-id', enableFlagEvaluationTracking: true },
    eventManager
  )!;
  // Two evaluations of one flag: one aggregated flagevaluation event with count 2.
  for (let index = 0; index < 2; index += 1) {
    aggregator.add({
      flagKey: 'targeted-flag',
      variant: 'variant-a',
      allocationKey: 'targeted-pro',
      reason: 'TARGETING_MATCH',
      doLog: true,
      contextRevision: 0,
      timestamp: Date.now() as TimeStamp,
    });
  }
  aggregator.stop(); // flushes the aggregated event onto the flagevaluation track
  await transport.flush();
  const trackPath = path.join(userData.path, 'flagevaluation');
  return { transport, consentManager, trackPath };
}

describe('flag evaluation metrics and tracking consent (real aggregator → Transport) (R7)', () => {
  beforeEach(async () => {
    userData.path = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-sdk-metrics-consent-'));
  });

  afterEach(async () => {
    await fs.rm(userData.path, { recursive: true, force: true });
  });

  it('granted: the aggregated event is persisted for upload', async () => {
    const { trackPath } = await setup('granted');
    const authorized = await readLogs(trackPath);
    expect(authorized).toHaveLength(1);
    expect(authorized[0]).toContain('"targeted-flag"');
    expect(authorized[0]).toContain('"evaluation_count":2');
    expect(await readPendingLogs(trackPath)).toEqual([]);
  });

  it('not-granted: nothing is persisted', async () => {
    const { trackPath } = await setup('not-granted');
    expect(await readLogs(trackPath)).toEqual([]);
    expect(await readPendingLogs(trackPath)).toEqual([]);
  });

  it('pending: the event is held as pending, then promoted when consent is granted', async () => {
    const { trackPath, consentManager, transport } = await setup('pending');
    expect(await readLogs(trackPath)).toEqual([]);
    const pending = await readPendingLogs(trackPath);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain('"evaluation_count":2');
    consentManager.update('granted');
    await vi.waitFor(async () => {
      await transport.flush();
      expect(await readPendingLogs(trackPath)).toEqual([]);
      const authorized = await readLogs(trackPath);
      expect(authorized.join('')).toContain('"evaluation_count":2');
    });
  });

  it('pending: the event is deleted when consent is refused', async () => {
    const { trackPath, consentManager, transport } = await setup('pending');
    expect(await readPendingLogs(trackPath)).toHaveLength(1);
    consentManager.update('not-granted');
    await vi.waitFor(async () => {
      await transport.flush();
      expect(await readPendingLogs(trackPath)).toEqual([]);
    });
    expect(await readLogs(trackPath)).toEqual([]);
  });
});
