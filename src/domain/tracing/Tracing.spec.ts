import { describe, expect, it, vi } from 'vitest';
import { createTestConfiguration } from '../../mocks.specUtil';
import { Tracing } from './Tracing';

function createTracerRequire() {
  const configure = vi.fn();
  const flush = vi.fn((done: () => void) => done());
  const tracer = {
    _tracingInitialized: true,
    _tracer: {
      _exporter: { flush },
      _prioritySampler: { configure },
    },
  };
  const requireFn = ((id: string) => {
    if (id === 'dd-trace') return { default: tracer };
    if (id === 'dd-trace/package.json') return { version: '6.10.0' };
    throw new Error(`Unexpected module: ${id}`);
  }) as NodeRequire;
  return { configure, flush, requireFn };
}

describe('Tracing', () => {
  it('configures dd-trace with normalized matching rules', () => {
    const { configure, requireFn } = createTracerRequire();

    const tracing = new Tracing(
      createTestConfiguration({
        env: 'production',
        traceSamplingRules: [
          { tags: { 'http.url': '*/health' }, sampleRate: 5 },
          { name: 'electron.main.*', sampleRate: 100 },
        ],
      }),
      requireFn
    );

    expect(configure).toHaveBeenCalledWith('production', {
      rateLimit: -1,
      rules: [
        { tags: { 'http.url': '*/health' }, sampleRate: 0.05 },
        { name: 'electron.main.*', sampleRate: 1 },
      ],
    });
    expect(tracing.enabled).toBe(true);
    expect(tracing.telemetryInitialized).toBe(true);
    expect(tracing.version).toBe('6.10.0');
  });

  it('keeps the existing dd-trace sampler when no rules are configured', () => {
    const { configure, requireFn } = createTracerRequire();

    new Tracing(createTestConfiguration({ traceSamplingRules: [] }), requireFn);

    expect(configure).not.toHaveBeenCalled();
  });

  it('flushes the dd-trace exporter', async () => {
    const { flush, requireFn } = createTracerRequire();
    const tracing = new Tracing(createTestConfiguration(), requireFn);

    await tracing.flush();

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
