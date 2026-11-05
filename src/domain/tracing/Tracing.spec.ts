import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSampledSessionActive } from '../../common';
import { createTestConfiguration } from '../../mocks.specUtil';
import { Tracing } from './Tracing';
import { createBundledModeBanner } from '../../entries/tracer-runtime';

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
    if (id === 'dd-trace-electron') return { default: tracer };
    throw new Error(`Unexpected module: ${id}`);
  }) as NodeRequire;
  return { init, use, flush, requireFn };
}

describe('Tracing', () => {
  afterEach(() => {
    setSampledSessionActive(false);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:bundledMode')];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:embeddedTracer')];
  });

  it('initializes dd-trace-electron with normalized matching rules and a fallback sample rate', () => {
    const { init, requireFn } = createTracerRequire();

    const tracing = new Tracing(
      createTestConfiguration({
        env: 'production',
        traceSampleRate: 25,
        traceSamplingRules: [
          { tags: { 'http.url': '*/health' }, sampleRate: 5 },
          { name: 'http.*', sampleRate: 100 },
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
        { name: 'http.*', sampleRate: 1 },
      ],
    });
    expect(tracing.enabled).toBe(true);
    expect(tracing.telemetryInitialized).toBe(true);
    expect(tracing.version).toBe('6.23.0');
  });

  it('initializes the embedded tracer selected by the plugin banner', () => {
    // Exercise the process-wide handoff between the plugin, instrumentation, and init bundles.
    runInNewContext(createBundledModeBanner(true), { globalThis, Symbol });
    const { requireFn } = createTracerRequire();
    const embeddedRequire = vi.fn((id: string) => {
      expect(id).toBe('./tracer.cjs');
      return requireFn('dd-trace-electron') as unknown;
    });

    const tracing = new Tracing(createTestConfiguration(), embeddedRequire as unknown as NodeRequire);

    expect(tracing.enabled).toBe(true);
    expect(tracing.telemetryInitialized).toBe(true);
    expect(embeddedRequire).toHaveBeenCalledOnce();
  });

  it('reuses the tracer loaded by emitted instrumentation when init is bundled elsewhere', () => {
    const tracer = { init: vi.fn(), use: vi.fn(), _tracingInitialized: true };
    (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:bundledMode')] = true;
    (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:embeddedTracer')] = tracer;
    const requireFn = vi.fn(() => {
      throw new Error('No tracer beside application bundle');
    });

    const tracing = new Tracing(createTestConfiguration(), requireFn as unknown as NodeRequire);

    expect(tracing.enabled).toBe(true);
    expect(tracer.init).toHaveBeenCalledOnce();
    expect(requireFn).not.toHaveBeenCalled();
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
        traceSamplingRules: [{ name: 'http.*', sampleRate: 50 }],
      }),
      requireFn
    );

    expect(init).toHaveBeenCalledWith({
      experimental: { exporter: 'electron' },
      rateLimit: -1,
      sampleRate: 1,
      samplingRules: [{ name: 'http.*', sampleRate: 0.5 }],
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

  it('gates dd-trace-electron HTTP propagation on the current RUM session', () => {
    const { requireFn, use } = createTracerRequire();

    new Tracing(createTestConfiguration(), requireFn);

    expect(use).toHaveBeenCalledWith('fetch', {
      propagationBlocklist: expect.any(Function) as unknown,
    });
    expect(use).toHaveBeenCalledWith('http', {
      client: { propagationBlocklist: expect.any(Function) as unknown },
    });

    const propagationBlocklist = (use.mock.calls[0][1] as { propagationBlocklist: () => boolean }).propagationBlocklist;
    setSampledSessionActive(true);
    expect(propagationBlocklist()).toBe(false);
    setSampledSessionActive(false);
    expect(propagationBlocklist()).toBe(true);
  });

  it('flushes the dd-trace-electron exporter', async () => {
    const { flush, requireFn } = createTracerRequire();
    const tracing = new Tracing(createTestConfiguration(), requireFn);

    await tracing.flush();

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
