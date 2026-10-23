import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isCurrentSessionSampled, setCurrentSessionSampled } from './sessionSamplingState';

describe('sessionSamplingState', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:sessionSamplingState')];
  });

  it('blocks propagation until the session decision is available', () => {
    expect(isCurrentSessionSampled()).toBe(false);
  });

  it('stores the current session decision', () => {
    setCurrentSessionSampled(true);

    expect(isCurrentSessionSampled()).toBe(true);
  });

  it('shares state across separate module evaluations', async () => {
    setCurrentSessionSampled(true);
    vi.resetModules();

    const fresh = await import('./sessionSamplingState');

    expect(fresh.isCurrentSessionSampled()).toBe(true);
  });
});
