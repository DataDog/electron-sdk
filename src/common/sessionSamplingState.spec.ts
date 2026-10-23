import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSampledSessionActive, setSampledSessionActive } from './sessionSamplingState';

describe('sessionSamplingState', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:sessionSamplingState')];
  });

  it('blocks propagation until the session decision is available', () => {
    expect(isSampledSessionActive()).toBe(false);
  });

  it('stores whether a sampled session is active', () => {
    setSampledSessionActive(true);

    expect(isSampledSessionActive()).toBe(true);
  });

  it('shares state across separate module evaluations', async () => {
    setSampledSessionActive(true);
    vi.resetModules();

    const fresh = await import('./sessionSamplingState');

    expect(fresh.isSampledSessionActive()).toBe(true);
  });
});
