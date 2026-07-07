import { describe, it, expect, vi } from 'vitest';
import { loadTracer } from './instrument-prelude';

describe('loadTracer', () => {
  it('returns the dd-trace default export when require succeeds', () => {
    const tracer = { init: vi.fn() };
    const requireFn = (() => ({ default: tracer })) as unknown as NodeRequire;

    expect(loadTracer(requireFn)).toBe(tracer);
  });

  it('falls back to a safe no-op tracer when dd-trace cannot be loaded (does not throw)', () => {
    // A load failure must not throw — otherwise `import '@datadog/electron-sdk/instrument'` would
    // crash the app instead of degrading to monitoring-disabled.
    const requireFn = (() => {
      throw new Error('MODULE_NOT_FOUND');
    }) as unknown as NodeRequire;

    const tracer = loadTracer(requireFn);

    expect(() => tracer.init({})).not.toThrow();
    expect(tracer.startSpan('x')).toBeUndefined();
    expect(tracer.scope().active()).toBeNull();
    expect(tracer.scope().activate({} as never, () => 42)).toBe(42);
    expect(() => tracer.inject({} as never, 'http_headers', {})).not.toThrow();
  });
});
