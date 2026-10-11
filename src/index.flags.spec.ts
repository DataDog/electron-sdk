import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration, InitConfiguration } from './config';

const { startFeatureFlagsMock, stopFeatureFlagsMock, quitFlushes, calls, pendingFrame } = vi.hoisted(() => ({
  startFeatureFlagsMock: vi.fn().mockResolvedValue(undefined),
  stopFeatureFlagsMock: vi.fn().mockResolvedValue(undefined),
  quitFlushes: [] as (() => Promise<void>)[],
  calls: [] as string[],
  pendingFrame: { origin: 'app://window', url: 'app://window/', processId: 3, routingId: 4, send: vi.fn() },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/userData'),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    on: vi.fn(),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: vi.fn(),
  webFrameMain: { fromId: vi.fn(() => pendingFrame) },
}));

vi.mock('./domain/flags/startFeatureFlags', () => ({
  startFeatureFlags: startFeatureFlagsMock,
  stopFeatureFlags: stopFeatureFlagsMock,
}));

vi.mock('./domain/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./domain/telemetry')>();
  return {
    ...actual,
    startTelemetry: vi.fn(),
    reportConfiguration: vi.fn(),
    addUsage: vi.fn(),
  };
});

vi.mock('./domain/session', () => ({
  SessionManager: { start: vi.fn().mockResolvedValue({ expire: vi.fn() }) },
  SESSION_TIME_OUT_DELAY: 1800000,
}));

vi.mock('./domain/replay', () => ({
  ReplayCollection: class {
    static start = vi.fn().mockResolvedValue({ stop: vi.fn(), getApi: vi.fn() });
    stop = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('./domain/rum', () => ({
  RumCollection: {
    start: vi.fn().mockResolvedValue({
      getApi: vi.fn(),
      getMainViewEmitter: vi.fn(() => ({ findViewId: vi.fn(), requestViewUpdate: vi.fn() })),
    }),
  },
}));

vi.mock('./transport', () => ({
  Transport: { create: vi.fn().mockResolvedValue({ flush: vi.fn(() => calls.push('transport.flush')) }) },
}));

vi.mock('./domain/tracing/Tracing', () => ({
  Tracing: class {
    enabled = false;
    flush = vi.fn();
  },
}));

vi.mock('./domain/tracing/SpanProcessor', () => ({ SpanProcessor: vi.fn() }));

vi.mock('./domain/profiling', () => ({
  ProfilingCollection: class {},
}));

vi.mock('./domain/customer-context', () => ({
  UserContext: { init: vi.fn().mockResolvedValue({}) },
  AccountContext: { init: vi.fn().mockResolvedValue({}) },
  GlobalContext: { init: vi.fn().mockResolvedValue({ getContext: vi.fn() }) },
}));

vi.mock('./tools/BeforeQuitHandler', () => ({
  BeforeQuitHandler: class {
    stop = vi.fn();
    constructor(_app: unknown, flush: () => Promise<void>) {
      quitFlushes.push(flush);
    }
  },
}));

import { init } from './index';
import { addPendingSubscriber, getFlagsHolder } from './common/flags/flagsHolder';

const BASE_CONFIGURATION: InitConfiguration = {
  site: 'datadoghq.com',
  service: 'test-service',
  clientToken: 'test-token',
  applicationId: 'test-app-id',
  allowedRendererHosts: ['*'],
  env: 'e2e',
};

describe('init feature flags wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startFeatureFlagsMock.mockResolvedValue(undefined);
  });

  it('starts the owner, collector and RUM context when featureFlags is enabled', async () => {
    await init({
      ...BASE_CONFIGURATION,
      featureFlags: { env: 'e2e', enableExposureLogging: true, enableRumFeatureFlagTracking: true },
    });
    expect(startFeatureFlagsMock).toHaveBeenCalledTimes(1);
    const [configuration, deps] = startFeatureFlagsMock.mock.calls[0] as [
      Configuration,
      { eventManager: unknown; hooks: unknown; mainViewEmitter: unknown },
    ];
    expect(configuration.featureFlags).toBeDefined();
    expect(deps.mainViewEmitter).toBeDefined();
    expect(deps.eventManager).toBeDefined();
    expect(deps.hooks).toBeDefined();
  });

  it('does not start the flags subsystem when featureFlags is absent', async () => {
    await init({ ...BASE_CONFIGURATION });

    expect(startFeatureFlagsMock).not.toHaveBeenCalled();
  });

  it('answers DISABLED to snapshot requests when featureFlags is absent, and tells frames that asked before init', async () => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsHolder')];
    addPendingSubscriber(pendingFrame);

    await init({ ...BASE_CONFIGURATION });

    const handler = getFlagsHolder().flagsStateHandler;
    expect(handler).toBeDefined();
    expect(JSON.parse(handler!({} as Electron.IpcMainInvokeEvent) as string)).toMatchObject({ status: 'DISABLED' });
    expect(pendingFrame.send).toHaveBeenCalledWith('datadog:flags-update', expect.stringContaining('"DISABLED"'));
  });
});

describe('feature flags shutdown and re-init (B7, B8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startFeatureFlagsMock.mockResolvedValue(undefined);
    stopFeatureFlagsMock.mockResolvedValue(undefined);
    stopFeatureFlagsMock.mockImplementation(() => {
      calls.push('flags.stop');
      return Promise.resolve();
    });
  });

  it('on quit, stops the flags controller (flushing pending metrics) before the transport flush (B7)', async () => {
    await init({ ...BASE_CONFIGURATION, featureFlags: { env: 'e2e' } });
    const onQuit = quitFlushes[quitFlushes.length - 1];
    calls.length = 0;
    await onQuit();
    expect(calls[0]).toBe('flags.stop');
    expect(calls.slice(1)).toContain('transport.flush');
  });

  it('a flags stop failure on quit still flushes the transport (B7)', async () => {
    await init({ ...BASE_CONFIGURATION, featureFlags: { env: 'e2e' } });
    stopFeatureFlagsMock.mockRejectedValueOnce(new Error('stop failure'));
    calls.length = 0;
    await quitFlushes[quitFlushes.length - 1]();
    expect(calls).toContain('transport.flush');
  });

  it('re-init without featureFlags stops the previous flags controller (B8)', async () => {
    await init({ ...BASE_CONFIGURATION, featureFlags: { env: 'e2e' } });
    stopFeatureFlagsMock.mockClear();
    await init({ ...BASE_CONFIGURATION });
    expect(stopFeatureFlagsMock).toHaveBeenCalledTimes(1);
  });
});
