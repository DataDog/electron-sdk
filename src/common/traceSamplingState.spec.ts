import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTraceSampled, setTraceSampled } from './traceSamplingState';

describe('traceSamplingState', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:traceSamplingState')];
  });

  it('preserves tracing before init for backward compatibility', () => {
    expect(isTraceSampled()).toBe(true);
  });

  it('stores the current session decision', () => {
    setTraceSampled(false);
    expect(isTraceSampled()).toBe(false);
  });

  it('shares state across separate module evaluations', async () => {
    setTraceSampled(false);
    vi.resetModules();
    const fresh = await import('./traceSamplingState');
    expect(fresh.isTraceSampled()).toBe(false);
  });
});
