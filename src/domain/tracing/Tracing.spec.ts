import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentSessionSampled } from '../../common';
import { createTestConfiguration } from '../../mocks.specUtil';
import { Tracing } from './Tracing';

function createTracerRequire() {
  const init = vi.fn();
  const use = vi.fn<(plugin: string, config: unknown) => void>();
  const flush = vi.fn((done: () => void) => done());
  const tracer = {
    init,
    use,
    _tracingInitialized: true,
    _tracer: {
      _exporter: { flush },
    },
  };
  const requireFn = ((id: string) => {
    if (id === 'dd-trace') return { default: tracer };
    if (id === 'dd-trace/package.json') return { version: '6.10.0' };
    throw new Error(`Unexpected module: ${id}`);
  }) as NodeRequire;
  return { init, use, flush, requireFn };
}

describe('Tracing', () => {
  afterEach(() => setCurrentSessionSampled(true));

  it('initializes dd-trace with normalized matching rules and a fallback sample rate', () => {
    const { init, requireFn } = createTracerRequire();

    const tracing = new Tracing(
      createTestConfiguration({
        env: 'production',
        traceSampleRate: 25,
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
      sampleRate: 0.25,
      samplingRules: [
        { tags: { 'http.url': '*/health' }, sampleRate: 0.05 },
        { name: 'electron.main.*', sampleRate: 1 },
      ],
    });
    expect(tracing.enabled).toBe(true);
    expect(tracing.telemetryInitialized).toBe(true);
    expect(tracing.version).toBe('6.10.0');
  });

  it('uses the trace sample rate without sampling rules', () => {
    const { init, requireFn } = createTracerRequire();

    new Tracing(createTestConfiguration({ traceSampleRate: 40, traceSamplingRules: [] }), requireFn);

    expect(init).toHaveBeenCalledWith({
      experimental: { exporter: 'electron' },
      rateLimit: -1,
      sampleRate: 0.4,
    });
  });

  it('uses the default sample rate with sampling rules', () => {
    const { init, requireFn } = createTracerRequire();

    new Tracing(
      createTestConfiguration({
        traceSamplingRules: [{ name: 'electron.main.*', sampleRate: 50 }],
      }),
      requireFn
    );

    expect(init).toHaveBeenCalledWith({
      experimental: { exporter: 'electron' },
      rateLimit: -1,
      sampleRate: 1,
      samplingRules: [{ name: 'electron.main.*', sampleRate: 0.5 }],
    });
  });

  it('uses the default trace sample rate when none is configured', () => {
    const { init, requireFn } = createTracerRequire();

    new Tracing(createTestConfiguration(), requireFn);

    expect(init).toHaveBeenCalledWith({
      experimental: { exporter: 'electron' },
      rateLimit: -1,
      sampleRate: 1,
    });
  });

  it('gates dd-trace HTTP propagation on the current RUM session', () => {
    const { requireFn, use } = createTracerRequire();

    new Tracing(createTestConfiguration(), requireFn);

    expect(use).toHaveBeenCalledWith('fetch', {
      propagationBlocklist: expect.any(Function) as unknown,
    });
    expect(use).toHaveBeenCalledWith('http', {
      client: { propagationBlocklist: expect.any(Function) as unknown },
    });

    const propagationBlocklist = use.mock.calls[0][1].propagationBlocklist as () => boolean;
    expect(propagationBlocklist()).toBe(false);
    setCurrentSessionSampled(false);
    expect(propagationBlocklist()).toBe(true);
  });

  it('flushes the dd-trace exporter', async () => {
    const { flush, requireFn } = createTracerRequire();
    const tracing = new Tracing(createTestConfiguration(), requireFn);

    await tracing.flush();

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
