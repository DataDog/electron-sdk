import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventKind, EventTrack, type ServerEvent } from './event';
import { createTestConfiguration } from './mocks.specUtil';
import type { TrackingConsent } from './domain/tracking-consent';

vi.mock('node:fs/promises');
vi.mock('electron', () => ({
  app: {
    getPath: () => '/mock/user/data',
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

let sdk: typeof import('./index');

beforeEach(async () => {
  // init() runs once per launch: each test loads the SDK fresh.
  vi.resetModules();
  sdk = await import('./index');
});

afterEach(async () => {
  (await import('./domain/telemetry')).stopTelemetry();
  vi.restoreAllMocks();
  post.mockClear();
});

it('routes SDK errors while transport initialization is still in progress', async () => {
  const { addError } = await import('./domain/telemetry');
  const error = new Error('upload failed during initialization');
  createBatchManager.mockImplementation(async (_configuration, { trackType }: { trackType: EventTrack }) => {
    if (trackType === EventTrack.RUM) return { post };
    // The RUM track is ready while a later track is still being initialized.
    await Promise.resolve();
    addError(error);
    throw error;
  });

  await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toBe(error);

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
  const startSession = vi.spyOn((await import('./domain/session')).SessionManager, 'start');
  createBatchManager.mockRejectedValue(new Error('transport failed'));

  await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toThrow('transport failed');

  // Transport subscribes to consent while it is created, and must apply a change before the session manager does.
  expect(startSession).not.toHaveBeenCalled();
});

it('starts the session manager under the init option', async () => {
  const { SessionManager } = await import('./domain/session');
  createBatchManager.mockResolvedValue({ post: vi.fn() });
  let consentAtSessionStart: TrackingConsent | undefined;
  vi.spyOn(SessionManager, 'start').mockImplementation((_events, _hooks, _config, trackingConsentManager) => {
    consentAtSessionStart = trackingConsentManager.get();
    return Promise.reject(new Error('stop before collection'));
  });

  await expect(
    sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'], trackingConsent: 'not-granted' }))
  ).rejects.toThrow('stop before collection');
  expect(consentAtSessionStart).toBe('not-granted');
});

it('publishes the bridge config without records before its first await', async () => {
  const { getBridgeConfig } = await import('./common');
  createBatchManager.mockRejectedValue(new Error('transport failed'));

  const initializing = sdk.init(
    createTestConfiguration({
      allowedRendererHosts: ['example.com'],
      profilingSampleRate: 100,
      sessionReplaySampleRate: 100,
    })
  );

  expect(getBridgeConfig()).toEqual({
    defaultPrivacyLevel: 'mask',
    allowedRendererHosts: ['example.com'],
    capabilities: ['profiles'],
  });
  await expect(initializing).rejects.toThrow('transport failed');
});

it('ignores an init() called after one with a valid configuration, even a failed one', async () => {
  const { TrackingConsentManager } = await import('./domain/tracking-consent');
  const createManager = vi.spyOn(TrackingConsentManager, 'init');
  createBatchManager.mockRejectedValue(new Error('transport failed'));
  await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toThrow('transport failed');
  const error = vi.spyOn((await import('./tools/display')).display, 'error').mockImplementation(() => undefined);

  await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).resolves.toBe(false);

  expect(createManager).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledExactlyOnceWith('init() was already called: this call is ignored.');
});

it('accepts an init() called after one with an invalid configuration', async () => {
  vi.spyOn((await import('./tools/display')).display, 'error').mockImplementation(() => undefined);
  createBatchManager.mockRejectedValue(new Error('transport failed'));
  await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'], clientToken: '' }))).resolves.toBe(
    false
  );

  await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toThrow('transport failed');
});

describe('after a complete init()', () => {
  beforeEach(() => {
    // A completed init() starts SDK timers: fake timers keep them from running after the test.
    vi.useFakeTimers();
    createBatchManager.mockResolvedValue({ post });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function initFully(trackingConsent: TrackingConsent): Promise<boolean> {
    return sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'], profilingSampleRate: 0, trackingConsent }));
  }

  function configurationEvents() {
    return post.mock.calls
      .map(
        ([event]) =>
          event.data as { session?: { id?: string }; telemetry?: { configuration?: { tracking_consent?: string } } }
      )
      .filter((data) => data.telemetry?.configuration !== undefined);
  }

  function reportedConsents(): (string | undefined)[] {
    return configurationEvents().map((data) => data.telemetry?.configuration?.tracking_consent);
  }

  it('reports the configuration at the end of a granted init()', async () => {
    await expect(initFully('granted')).resolves.toBe(true);

    expect(reportedConsents()).toEqual(['granted']);
  });

  it('reports the configuration of a pending start at the first grant, even after a refusal', async () => {
    await expect(initFully('pending')).resolves.toBe(true);
    sdk.setTrackingConsent('not-granted');
    expect(reportedConsents()).toEqual([]);

    sdk.setTrackingConsent('granted');

    expect(reportedConsents()).toEqual(['pending']);
  });

  it('reports the configuration of a refused start once consent is granted', async () => {
    await expect(initFully('not-granted')).resolves.toBe(true);
    sdk.setTrackingConsent('pending');
    expect(reportedConsents()).toEqual([]);

    sdk.setTrackingConsent('granted');
    const grantedSessionId = sdk.getInternalContext()?.session_id;
    sdk.setTrackingConsent('not-granted');
    sdk.setTrackingConsent('granted');

    expect(reportedConsents()).toEqual(['not-granted']);
    expect(grantedSessionId).toBeDefined();
    expect(configurationEvents()[0].session?.id).toBe(grantedSessionId);
  });

  it('defers the configuration report when consent is refused while init() runs', async () => {
    createBatchManager.mockImplementationOnce(() => {
      sdk.setTrackingConsent('not-granted');
      return Promise.resolve({ post });
    });

    await expect(initFully('granted')).resolves.toBe(true);
    expect(reportedConsents()).toEqual([]);

    sdk.setTrackingConsent('granted');
    expect(reportedConsents()).toEqual(['granted']);
  });
});
