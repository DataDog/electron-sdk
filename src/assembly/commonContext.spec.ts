import { describe, it, expect } from 'vitest';
import type { TimeStamp } from '@datadog/js-core/time';
import { registerCommonContext } from './commonContext';
import { createFormatHooks } from './hooks';
import { EventSource } from '../event';
import type { Configuration } from '../config';

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
    telemetrySampleRate: 20,
    ...overrides,
  };
}

function triggerMainRum(config: Configuration) {
  const hooks = createFormatHooks();
  registerCommonContext(config, hooks);
  return hooks.triggerRum({ eventType: 'view', startTime: T0, source: EventSource.MAIN }) as Record<string, unknown>;
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
      { configKey: 'env' as const, tagKey: 'env' },
      { configKey: 'version' as const, tagKey: 'version' },
    ])('omits $tagKey tag when $configKey is not configured', ({ configKey, tagKey }) => {
      const tags = parseDdtags(triggerMainRum(makeConfig({ [configKey]: undefined })));

      expect(tags.some((t) => t.startsWith(`${tagKey}:`))).toBe(false);
    });
  });
});
