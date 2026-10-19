import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

type Consent = TrackingConsent | undefined;
it.each<[string, Consent, Consent, Consent, TrackingConsent]>([
  ['the default consent', undefined, undefined, undefined, 'granted'],
  ['the init option', 'not-granted', undefined, undefined, 'not-granted'],
  ['a consent set before init()', 'granted', 'not-granted', undefined, 'not-granted'],
  ['a grant set before init() over a refusing option', 'not-granted', 'granted', undefined, 'granted'],
  ['a consent set while init() is in progress', 'granted', undefined, 'not-granted', 'not-granted'],
])('starts the session manager under %s', async (_title, option, setBefore, setDuring, expected) => {
  // The consent last set by the app is module state: load the SDK fresh, so earlier tests leave none.
  vi.resetModules();
  const sdk = await import('./index');
  const { SessionManager: FreshSessionManager } = await import('./domain/session');
  createBatchManager.mockResolvedValue({ post: vi.fn() });
  let consentAtSessionStart: TrackingConsent | undefined;
  vi.spyOn(FreshSessionManager, 'start').mockImplementation((_events, _hooks, _config, trackingConsentManager) => {
    consentAtSessionStart = trackingConsentManager.get();
    return Promise.reject(new Error('stop before collection'));
  });
  try {
    if (setBefore) sdk.setTrackingConsent(setBefore);
    const initializing = sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'], trackingConsent: option }));
    if (setDuring) sdk.setTrackingConsent(setDuring);

    await expect(initializing).rejects.toThrow('stop before collection');
    expect(consentAtSessionStart).toBe(expected);
  } finally {
    (await import('./domain/telemetry')).stopTelemetry();
  }
});

it('creates the transport under a consent set before init()', async () => {
  vi.resetModules();
  const sdk = await import('./index');
  const { Transport } = await import('./transport');
  let consentAtTransportCreation: TrackingConsent | undefined;
  vi.spyOn(Transport, 'create').mockImplementation((_config, _events, trackingConsentManager) => {
    consentAtTransportCreation = trackingConsentManager.get();
    return Promise.reject(new Error('stop before collection'));
  });
  try {
    sdk.setTrackingConsent('not-granted');
    await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toThrow(
      'stop before collection'
    );
    expect(consentAtTransportCreation).toBe('not-granted');
  } finally {
    (await import('./domain/telemetry')).stopTelemetry();
  }
});

it('ignores an init() called while another one runs', async () => {
  vi.resetModules();
  const sdk = await import('./index');
  const { TrackingConsentManager } = await import('./domain/tracking-consent');
  const createManager = vi.spyOn(TrackingConsentManager, 'init');
  vi.spyOn((await import('./tools/display')).display, 'error').mockImplementation(() => undefined);
  createBatchManager.mockRejectedValue(new Error('transport failed'));
  try {
    const first = sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }));

    await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).resolves.toBe(false);
    await expect(first).rejects.toThrow('transport failed');
    expect(createManager).toHaveBeenCalledOnce();
  } finally {
    (await import('./domain/telemetry')).stopTelemetry();
  }
});

it('accepts an init() retried after a failure', async () => {
  vi.resetModules();
  const sdk = await import('./index');
  const { TrackingConsentManager } = await import('./domain/tracking-consent');
  const createManager = vi.spyOn(TrackingConsentManager, 'init');
  vi.spyOn((await import('./tools/display')).display, 'error').mockImplementation(() => undefined);
  createBatchManager.mockRejectedValue(new Error('transport failed'));
  try {
    await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'], clientToken: '' }))).resolves.toBe(
      false
    );
    await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toThrow(
      'transport failed'
    );
    await expect(sdk.init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toThrow(
      'transport failed'
    );

    expect(createManager).toHaveBeenCalledTimes(2);
  } finally {
    (await import('./domain/telemetry')).stopTelemetry();
  }
});

describe('after a complete init()', () => {
  let sdk: typeof import('./index');

  beforeEach(async () => {
    // A completed init() starts SDK timers: fake timers keep them from running after the test.
    vi.useFakeTimers();
    vi.resetModules();
    sdk = await import('./index');
    createBatchManager.mockResolvedValue({ post });
    post.mockClear();
  });

  afterEach(async () => {
    (await import('./domain/telemetry')).stopTelemetry();
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

  it('reports a consent set before init() in configuration telemetry', async () => {
    sdk.setTrackingConsent('pending');
    await expect(initFully('granted')).resolves.toBe(true);

    sdk.setTrackingConsent('granted');

    expect(reportedConsents()).toEqual(['pending']);
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

  it('ignores an init() called after one succeeded', async () => {
    await expect(initFully('granted')).resolves.toBe(true);
    const { TrackingConsentManager } = await import('./domain/tracking-consent');
    const createManager = vi.spyOn(TrackingConsentManager, 'init');
    const error = vi.spyOn((await import('./tools/display')).display, 'error').mockImplementation(() => undefined);

    await expect(initFully('granted')).resolves.toBe(false);

    expect(createManager).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledExactlyOnceWith('init() was already called: this call is ignored.');
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
