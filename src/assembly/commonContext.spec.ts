import { describe, it, expect, vi } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { registerCommonContext, registerProcessContext } from './commonContext';
import { createFormatHooks } from './hooks';
import { EventSource } from '../event';
import type { Configuration } from '../config';
import { display } from '../tools/display';
import { ProcessContext } from '../domain/rum/process';

const T0 = 0 as TimeStamp;

function makeConfig(overrides: Partial<Configuration> = {}): Configuration {
  return {
    site: 'datadoghq.com',
    service: 'test-service',
    clientToken: 'test-token',
    applicationId: 'test-app-id',
    defaultPrivacyLevel: 'mask',
    allowedWebViewHosts: [],
    sessionSampleRate: 100,
    profilingSampleRate: 0,
    telemetrySampleRate: 20,
    ...overrides,
  };
}

function triggerMainRum(config: Configuration) {
  const hooks = createFormatHooks();
  registerCommonContext(config, hooks);
  return hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN }) as Record<string, unknown>;
}

function triggerRendererRum(config: Configuration) {
  const hooks = createFormatHooks();
  registerCommonContext(config, hooks);
  return hooks.triggerRum({
    eventType: 'view',
    startTime: T0,
    source: EventSource.RENDERER,
  }) as Record<string, unknown>;
}

function parseDdtags(result: Record<string, unknown>): string[] {
  return ((result.ddtags as string) ?? '').split(',').filter(Boolean);
}

describe('registerCommonContext', () => {
  describe('MAIN RUM events — top-level fields', () => {
    it.each([
      { field: 'service' as const, value: 'my-service' },
      { field: 'version' as const, value: '2.0.0' },
    ])('includes $field as a top-level field', ({ field, value }) => {
      const result = triggerMainRum(makeConfig({ [field]: value }));

      expect(result[field]).toBe(value);
    });
  });

  describe('MAIN RUM events — ddtags', () => {
    it('always includes sdk_version tag', () => {
      const tags = parseDdtags(triggerMainRum(makeConfig()));

      expect(tags.some((t) => t.startsWith('sdk_version:'))).toBe(true);
    });

    it.each([
      { configKey: 'service' as const, tagKey: 'service', value: 'my-service' },
      { configKey: 'env' as const, tagKey: 'env', value: 'production' },
      { configKey: 'version' as const, tagKey: 'version', value: '2.0.0' },
    ])('includes $tagKey tag when $configKey is configured', ({ configKey, tagKey, value }) => {
      const tags = parseDdtags(triggerMainRum(makeConfig({ [configKey]: value })));

      expect(tags).toContain(`${tagKey}:${value}`);
    });

    it.each([
      { configKey: 'service' as const, tagKey: 'service', raw: 'my,service', sanitized: 'my_service' },
      { configKey: 'env' as const, tagKey: 'env', raw: 'prod,us', sanitized: 'prod_us' },
      { configKey: 'version' as const, tagKey: 'version', raw: '1.0,0', sanitized: '1.0_0' },
    ])('replaces commas in $tagKey value to avoid corrupting ddtags', ({ configKey, tagKey, raw, sanitized }) => {
      const tags = parseDdtags(triggerMainRum(makeConfig({ [configKey]: raw })));

      expect(tags).toContain(`${tagKey}:${sanitized}`);
      expect(tags.some((t) => t.includes(','))).toBe(false);
    });

    it.each([
      { configKey: 'service' as const, tagKey: 'service', raw: 'my service' },
      { configKey: 'env' as const, tagKey: 'env', raw: 'prod!eu' },
      { configKey: 'version' as const, tagKey: 'version', raw: '1.0 0' },
    ])('warns when $tagKey value contains forbidden characters', ({ configKey, tagKey, raw }) => {
      const warnSpy = vi.spyOn(display, 'warn').mockReturnValue(undefined);

      triggerMainRum(makeConfig({ [configKey]: raw }));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`${tagKey}:${raw}`));
      warnSpy.mockRestore();
    });

    it('warns when a tag exceeds the 200-character size limit', () => {
      const warnSpy = vi.spyOn(display, 'warn').mockReturnValue(undefined);

      // 'env:' = 4 chars, so value of 197 chars = 201-char tag (first value > 200)
      triggerMainRum(makeConfig({ env: 'a'.repeat(197) }));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('env:'));
      warnSpy.mockRestore();
    });

    it('does not warn when a tag is exactly at the size limit', () => {
      const warnSpy = vi.spyOn(display, 'warn').mockReturnValue(undefined);

      // 'env:' = 4 chars, so value of 196 chars = exactly 200
      triggerMainRum(makeConfig({ env: 'a'.repeat(196) }));

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it.each([
      { configKey: 'service' as const, tagKey: 'service', raw: 'my-service:prod' },
      { configKey: 'env' as const, tagKey: 'env', raw: 'prod.eu/west' },
      { configKey: 'service' as const, tagKey: 'service', raw: 'my,service' },
    ])('does not warn when $tagKey value contains only allowed special characters', ({ configKey, raw }) => {
      const warnSpy = vi.spyOn(display, 'warn').mockReturnValue(undefined);

      triggerMainRum(makeConfig({ [configKey]: raw }));

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it.each([
      { configKey: 'env' as const, tagKey: 'env' },
      { configKey: 'version' as const, tagKey: 'version' },
    ])('omits $tagKey tag when $configKey is not configured', ({ configKey, tagKey }) => {
      const tags = parseDdtags(triggerMainRum(makeConfig({ [configKey]: undefined })));

      expect(tags.some((t) => t.startsWith(`${tagKey}:`))).toBe(false);
    });
  });

  describe('sampling rates in _dd.configuration', () => {
    it.each([EventSource.MAIN, EventSource.RENDERER])(
      'injects the Electron SDK session and profiling sample rates for %s events',
      (source) => {
        const config = makeConfig({ sessionSampleRate: 42, profilingSampleRate: 100 });
        const result = source === EventSource.MAIN ? triggerMainRum(config) : triggerRendererRum(config);

        expect((result._dd as { configuration: unknown }).configuration).toEqual({
          session_sample_rate: 42,
          profiling_sample_rate: 100,
        });
      }
    );

    it('preserves format_version on MAIN events alongside the configuration', () => {
      const result = triggerMainRum(makeConfig());

      expect(result._dd).toMatchObject({ format_version: 2 });
    });
  });

  describe('RENDERER RUM events', () => {
    it('adds the electron container source', () => {
      const result = triggerRendererRum(makeConfig());

      expect(result.container).toEqual({ source: 'electron' });
    });
  });
});

describe('registerProcessContext', () => {
  it('enriches main-process events with main process context', () => {
    const hooks = createFormatHooks();
    const processContext = new ProcessContext({ id: 'main-uuid', name: undefined });
    registerProcessContext(processContext, hooks);

    const result = hooks.triggerRum({ eventType: 'view', startTime: 0 as TimeStamp, source: EventSource.MAIN });
    expect(result).toMatchObject({ process: { id: 'main-uuid', role: 'main' } });
  });

  it('enriches renderer events with renderer process context when webContentsId is known', () => {
    const hooks = createFormatHooks();
    const processContext = new ProcessContext({ id: 'main-uuid', name: undefined });
    processContext.setRendererProcess(42, { id: 'renderer-uuid', name: undefined });
    registerProcessContext(processContext, hooks);

    const result = hooks.triggerRum({
      eventType: 'error',
      startTime: 0 as TimeStamp,
      source: EventSource.RENDERER,
      webContentsId: 42,
    });
    expect(result).toMatchObject({ process: { id: 'renderer-uuid', role: 'renderer' } });
  });

  it('skips renderer events when webContentsId is unknown', () => {
    const hooks = createFormatHooks();
    const processContext = new ProcessContext({ id: 'main-uuid', name: undefined });
    registerProcessContext(processContext, hooks);

    const result = hooks.triggerRum({
      eventType: 'error',
      startTime: 0 as TimeStamp,
      source: EventSource.RENDERER,
      webContentsId: 99,
    });
    // SKIPPED means result has no process field
    expect((result as Record<string, unknown> | null)?.process).toBeUndefined();
  });
});
