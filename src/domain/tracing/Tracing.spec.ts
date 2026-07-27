import { describe, expect, it, vi } from 'vitest';
import { createTestConfiguration } from '../../mocks.specUtil';
import { Tracing } from './Tracing';

function createTracerRequire() {
  const init = vi.fn();
  const flush = vi.fn((done: () => void) => done());
  const tracer = {
    init,
    _tracingInitialized: true,
    _tracer: {
      _exporter: { flush },
    },
  };
  const requireFn = ((id: string) => {
    if (id === 'dd-trace-electron') return { default: tracer };
    if (id === 'dd-trace-electron/package.json') return { version: '6.11.0' };
    throw new Error(`Unexpected module: ${id}`);
  }) as NodeRequire;
  return { init, flush, requireFn };
}

describe('Tracing', () => {
  it('initializes dd-trace-electron with normalized matching rules', () => {
    const { init, requireFn } = createTracerRequire();

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

    expect(init).toHaveBeenCalledWith({
      env: 'production',
      experimental: { exporter: 'electron' },
      rateLimit: -1,
      samplingRules: [
        { tags: { 'http.url': '*/health' }, sampleRate: 0.05 },
        { name: 'electron.main.*', sampleRate: 1 },
      ],
    });
    expect(tracing.enabled).toBe(true);
    expect(tracing.telemetryInitialized).toBe(true);
    expect(tracing.version).toBe('6.11.0');
  });

  it('preserves dd-trace-electron sampling configuration when no rules are configured', () => {
    const { init, requireFn } = createTracerRequire();

    new Tracing(createTestConfiguration({ traceSamplingRules: [] }), requireFn);

    expect(init).toHaveBeenCalledWith({ experimental: { exporter: 'electron' } });
  });

  it('flushes the dd-trace-electron exporter', async () => {
    const { flush, requireFn } = createTracerRequire();
    const tracing = new Tracing(createTestConfiguration(), requireFn);

    await tracing.flush();

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
