import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAddUsage, mockDisplayError } = vi.hoisted(() => ({
  mockAddUsage: vi.fn(),
  mockDisplayError: vi.fn(),
}));

vi.mock('./domain/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./domain/telemetry')>();
  return {
    ...actual,
    addUsage: mockAddUsage,
    callMonitored: <T>(callback: () => T) => callback(),
  };
});

vi.mock('./tools/display', () => ({
  display: { error: mockDisplayError },
}));

import { setTrackingConsent } from './index';

describe('setTrackingConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects invalid runtime values without recording usage or changing consent', () => {
    setTrackingConsent('invalid' as never);

    expect(mockDisplayError).toHaveBeenCalledOnce();
    expect(mockAddUsage).not.toHaveBeenCalled();
  });
});
