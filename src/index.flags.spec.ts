import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration, InitConfiguration } from './config';

const { startFeatureFlagsMock } = vi.hoisted(() => ({
  startFeatureFlagsMock: vi.fn().mockResolvedValue(undefined),
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
}));

vi.mock('./domain/flags/startFeatureFlags', () => ({
  startFeatureFlags: startFeatureFlagsMock,
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
  Transport: { create: vi.fn().mockResolvedValue({ flush: vi.fn() }) },
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
  },
}));

import { init } from './index';

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
});
