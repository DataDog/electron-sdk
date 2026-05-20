import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock heavy dependencies to isolate getInternalContext logic
vi.mock('./assembly', () => ({
  Assembly: vi.fn(),
  createFormatHooks: vi.fn(() => ({})),
  registerCommonContext: vi.fn(),
}));
vi.mock('./config', () => ({
  buildConfiguration: vi.fn(() => ({
    site: 'datadoghq.com',
    service: 'test',
    clientToken: 'tok',
    applicationId: 'app',
  })),
}));
vi.mock('./domain/rum', () => ({
  RumCollection: { start: vi.fn(() => ({ getApi: () => ({}) })) },
}));
vi.mock('./domain/UserActivityTracker', () => ({
  UserActivityTracker: vi.fn(),
}));
vi.mock('./domain/telemetry', () => ({
  callMonitored: vi.fn((fn: () => void) => fn()),
  startTelemetry: vi.fn(),
}));
vi.mock('./bridge', () => ({
  BridgeHandler: vi.fn(),
  registerPreload: vi.fn(),
}));
vi.mock('./transport', () => ({
  Transport: { create: vi.fn(() => ({ flush: vi.fn() })) },
}));

const mockGetSession = vi.fn();
vi.mock('./domain/session', () => ({
  SessionManager: {
    start: vi.fn(() => ({ getSession: mockGetSession })),
  },
}));

import { getInternalContext, init } from './index';

describe('getInternalContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined before init', () => {
    expect(getInternalContext()).toBeUndefined();
  });

  it('returns session_id after init', async () => {
    mockGetSession.mockReturnValue({ id: 'test-session-id', status: 'active' });

    await init({ site: 'datadoghq.com', service: 'test', clientToken: 'tok', applicationId: 'app' });

    const ctx = getInternalContext();
    expect(ctx).toEqual({ session_id: 'test-session-id' });
  });

  it('returns undefined when session is expired', () => {
    mockGetSession.mockReturnValue({ id: 'test-session-id', status: 'expired' });

    expect(getInternalContext()).toBeUndefined();
  });
});
