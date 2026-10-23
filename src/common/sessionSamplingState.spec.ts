import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isCurrentSessionSampled, setCurrentSessionSampled } from './sessionSamplingState';

describe('sessionSamplingState', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:sessionSamplingState')];
  });

  it('allows propagation until the session decision is available', () => {
    expect(isCurrentSessionSampled()).toBe(true);
  });

  it('stores the current session decision', () => {
    setCurrentSessionSampled(false);

    expect(isCurrentSessionSampled()).toBe(false);
  });

  it('shares state across separate module evaluations', async () => {
    setCurrentSessionSampled(false);
    vi.resetModules();

    const fresh = await import('./sessionSamplingState');

    expect(fresh.isCurrentSessionSampled()).toBe(false);
  });
});
