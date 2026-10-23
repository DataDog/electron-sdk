import { afterEach, expect, it, vi } from 'vitest';
import { init } from './index';
import { SessionManager } from './domain/session';
import { addError, stopTelemetry } from './domain/telemetry';
import { EventKind, EventTrack, type ServerEvent } from './event';
import { createTestConfiguration } from './mocks.specUtil';
import type { TrackingConsent } from './domain/tracking-consent';

vi.mock('node:fs/promises');
vi.mock('electron', () => ({
  app: {
    getPath: () => '/mock/user/data',
    getAppPath: () => '/mock/app',
    isReady: () => false,
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
  },
  ipcMain: { on: vi.fn() },
  crashReporter: { start: vi.fn() },
}));
vi.mock('./domain/tracing/Tracing', () => ({ Tracing: vi.fn() }));

const { createBatchManager, post } = vi.hoisted(() => ({
  createBatchManager: vi.fn(),
  post: vi.fn<(event: ServerEvent) => void>(),
}));
vi.mock('./transport/batch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport/batch')>()),
  BatchManager: { create: createBatchManager },
  BatchMigration: { clearPendingData: vi.fn().mockResolvedValue(undefined) },
}));

afterEach(() => {
  stopTelemetry();
  vi.restoreAllMocks();
  vi.useRealTimers();
  post.mockClear();
});

it('routes SDK errors while transport initialization is still in progress', async () => {
  const error = new Error('upload failed during initialization');
  createBatchManager.mockImplementation(async (_configuration, { trackType }: { trackType: EventTrack }) => {
    if (trackType === EventTrack.RUM) return { post };
    // The RUM track is ready while a later track is still being initialized.
    await Promise.resolve();
    addError(error);
    throw error;
  });

  await expect(init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toBe(error);

  expect(post.mock.calls.map(([event]) => event)).toMatchObject([
    {
      kind: EventKind.SERVER,
      track: EventTrack.RUM,
      data: {
        application: { id: 'test-app-id' },
        source: 'electron',
        telemetry: { status: 'error', message: error.message },
      },
    },
  ]);
});

it('creates transport before the session manager', async () => {
  const startSession = vi.spyOn(SessionManager, 'start');
  createBatchManager.mockRejectedValue(new Error('transport failed'));

  await expect(init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toThrow('transport failed');

  // Transport subscribes to consent while it is created, and must apply a change before the session manager does.
  expect(startSession).not.toHaveBeenCalled();
});

it('starts the session manager under the init option', async () => {
  createBatchManager.mockResolvedValue({ post: vi.fn() });
  let consentAtSessionStart: TrackingConsent | undefined;
  vi.spyOn(SessionManager, 'start').mockImplementation((_events, _hooks, _config, trackingConsentManager) => {
    consentAtSessionStart = trackingConsentManager.get();
    return Promise.reject(new Error('stop before collection'));
  });

  await expect(
    init(createTestConfiguration({ allowedRendererHosts: ['*'], trackingConsent: 'not-granted' }))
  ).rejects.toThrow('stop before collection');
  expect(consentAtSessionStart).toBe('not-granted');
});

it('reports the configuration at the end of init(), even while consent is pending', async () => {
  // A completed init() starts SDK timers: fake timers keep them from running after the test.
  vi.useFakeTimers();
  createBatchManager.mockResolvedValue({ post });

  await expect(
    init(createTestConfiguration({ allowedRendererHosts: ['*'], profilingSampleRate: 0, trackingConsent: 'pending' }))
  ).resolves.toBe(true);

  const reportedConsents = post.mock.calls
    .map(([event]) => event.data as { telemetry?: { configuration?: { tracking_consent?: string } } })
    .filter((data) => data.telemetry?.configuration !== undefined)
    .map((data) => data.telemetry?.configuration?.tracking_consent);
  expect(reportedConsents).toEqual(['pending']);
});
