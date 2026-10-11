import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventManager } from '../../event';
import { createFormatHooks } from '../../assembly';
import { createTestConfiguration } from '../../mocks.specUtil';
import { TrackingConsentManager, type TrackingConsent } from '../tracking-consent';
import { Transport } from '../../transport';
import { evaluationsMessage, encodeFrame } from '../../common/flags/childProtocol';
import { fixtureWire } from '../../common/flags/evaluationCases.specUtil';
import { closeAllFlagsChannels, openFlagsChannel } from './ChildFlagsHub';
import { getFeatureFlagsController, startFeatureFlags } from './startFeatureFlags';

/** Batch storage keeps undecided-consent events in sibling directories with this prefix. */
const PENDING_DIRECTORY_PREFIX = 'pending-';

const { userData } = vi.hoisted(() => ({ userData: { path: '' } }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const ipcMain = Object.assign(new EventEmitter(), { handle: () => undefined });
  return {
    app: { getPath: () => userData.path },
    ipcMain,
    webFrameMain: { fromId: () => undefined },
    webContents: { fromFrame: () => undefined },
    session: { fromPartition: () => ({}) },
  };
});

vi.mock('../../transport/batch/standard/StandardBatchConsumer', () => ({
  StandardBatchConsumer: vi.fn().mockImplementation(function (this: unknown) {
    return { upload: vi.fn().mockResolvedValue(undefined) };
  }),
}));

const rulesBinary = Uint8Array.from(
  atob((JSON.parse(fixtureWire) as { rules: { response: string } }).rules.response),
  (c) => c.charCodeAt(0)
);

const logFiles = async (directory: string) =>
  (await fs.readdir(directory).catch(() => [] as string[])).filter((file) => file.endsWith('.log'));

const pendingFiles = async (directory: string) => {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(PENDING_DIRECTORY_PREFIX)) {
      files.push(...(await logFiles(path.join(directory, entry.name))));
    }
  }
  return files;
};

describe('child exposures and tracking consent (real Transport)', () => {
  beforeEach(async () => {
    userData.path = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-sdk-child-consent-'));
  });

  afterEach(async () => {
    closeAllFlagsChannels();
    await getFeatureFlagsController()?.stop();
    await fs.rm(userData.path, { recursive: true, force: true });
  });

  it.each([
    ['pending', { authorized: 0, pending: 1 }],
    ['not-granted', { authorized: 0, pending: 0 }],
    ['granted', { authorized: 1, pending: 0 }],
  ] as const)('child exposures follow tracking consent (%s)', async (consent: TrackingConsent, expected) => {
    const configuration = createTestConfiguration({
      profilingSampleRate: 0,
      sessionReplaySampleRate: 0,
      featureFlags: {
        env: 'e2e',
        refreshInterval: 0,
        fetchTimeout: 500,
        persistConfiguration: false,
        enableExposureLogging: true,
        enableRumFeatureFlagTracking: false,
        enableFlagEvaluationTracking: false,
        excludedPartitions: [],
      },
    });
    const eventManager = new EventManager();
    const consentManager = await TrackingConsentManager.init(createFormatHooks());
    consentManager.update(consent);
    const transport = await Transport.create(configuration, eventManager, consentManager);
    const controller = (await startFeatureFlags(configuration, {
      eventManager,
      hooks: createFormatHooks(),
      mainViewEmitter: { findViewId: () => 'main-view', requestViewUpdate: () => undefined },
      fetch: () =>
        Promise.resolve(
          new Response(rulesBinary.slice().buffer, { status: 200, headers: { 'content-type': 'application/protobuf' } })
        ),
    }))!;
    await controller.settled();
    controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });

    const channel = openFlagsChannel({ kind: 'frames', name: 'server-host', send: () => undefined });
    channel.receive(
      encodeFrame(
        evaluationsMessage(
          JSON.stringify({
            records: [
              {
                flagKey: 'targeted-flag',
                variant: 'variant-a',
                allocationKey: 'targeted-pro',
                reason: 'TARGETING_MATCH',
                doLog: true,
                contextRevision: controller.state.snapshot().contextRevision,
                timestamp: Date.now(),
              },
            ],
          })
        )
      )
    );
    await transport.flush();

    const exposuresPath = path.join(userData.path, 'exposures');
    expect({
      authorized: (await logFiles(exposuresPath)).length,
      pending: (await pendingFiles(exposuresPath)).length,
    }).toEqual(expected);
  });
});
