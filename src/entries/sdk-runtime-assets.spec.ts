import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  copyFileSync: mocks.copyFileSync,
  mkdirSync: mocks.mkdirSync,
}));

import { createInstrumentationBanner, emitSdkRuntimeAssets } from './sdk-runtime-assets';

describe('SDK runtime assets', () => {
  it('uses an explicit relative request for an entry at the output root', () => {
    expect(createInstrumentationBanner('cjs')).toContain('"./.datadog/instrument.cjs"');
  });

  it('loads the emitted instrumentation relative to a nested Vite entry', () => {
    expect(createInstrumentationBanner('cjs', 'main/index.js')).toContain('"../.datadog/instrument.cjs"');
    expect(createInstrumentationBanner('esm', 'main/index.mjs')).toContain('"../.datadog/instrument.cjs"');
  });

  it('emits the instrumentation and preload without copying the full SDK package', () => {
    emitSdkRuntimeAssets('/sdk/dist/vite-plugin.cjs', '/app/dist');

    expect(mocks.mkdirSync).toHaveBeenCalledWith('/app/dist/.datadog', { recursive: true });
    expect(mocks.copyFileSync).toHaveBeenCalledWith('/sdk/dist/instrument.cjs', '/app/dist/.datadog/instrument.cjs');
    expect(mocks.copyFileSync).toHaveBeenCalledWith('/sdk/dist/preload.js', '/app/dist/.datadog/preload.js');
  });
});
