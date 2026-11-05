import { describe, expect, it, vi } from 'vitest';
import { copyFileSync } from 'node:fs';
import { createInstrumentationBanner, emitSdkRuntimeAssets } from './sdk-runtime-assets';

vi.mock('node:fs', () => ({ copyFileSync: vi.fn(), mkdirSync: vi.fn() }));

describe('SDK runtime assets', () => {
  it('uses explicit relative paths for root and nested entries on either platform', () => {
    expect(createInstrumentationBanner('cjs')).toContain('"./.datadog/instrument.cjs"');
    expect(createInstrumentationBanner('cjs', 'main/index.js')).toContain('"../.datadog/instrument.cjs"');
    expect(createInstrumentationBanner('esm', 'main\\index.mjs')).toContain('"../.datadog/instrument.cjs"');
  });

  it('emits instrumentation, preload, tracer, and licenses without the SDK package tree', () => {
    emitSdkRuntimeAssets('/sdk/dist/vite-plugin.cjs', '/app/dist');
    const destinations = vi.mocked(copyFileSync).mock.calls.map(([, dest]) => String(dest).split('\\').join('/'));
    expect(destinations).toEqual([
      '/app/dist/.datadog/instrument.cjs',
      '/app/dist/.datadog/preload.js',
      '/app/dist/.datadog/tracer.cjs',
      '/app/dist/.datadog/tracer.LICENSE',
    ]);
  });
});
