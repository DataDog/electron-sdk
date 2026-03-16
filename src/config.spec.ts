import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildConfiguration } from './config';
import type { InitConfiguration } from './config';

import * as display from './tools/display';
vi.mock('./tools/display', () => ({
  displayError: vi.fn(),
}));

describe('buildConfiguration', () => {
  // Default valid config used as base for all tests
  const DEFAULT_CONFIG: InitConfiguration = {
    site: 'datadoghq.com',
    service: 'test-service',
    clientToken: 'test-token',
    applicationId: 'test-app-id',
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe.each([
    { fieldName: 'service' as const },
    { fieldName: 'clientToken' as const },
    { fieldName: 'applicationId' as const },
  ])('required field validation: $fieldName', ({ fieldName }) => {
    it.each([
      { value: undefined, description: 'missing' },
      { value: '', description: 'empty string' },
      { value: 123, description: 'not a string' },
    ])('returns undefined when $description', ({ value }) => {
      const config = {
        ...DEFAULT_CONFIG,
        [fieldName]: value,
      } as unknown as InitConfiguration;

      expect(buildConfiguration(config)).toBeUndefined();
    });

    it('logs error to console when validation fails', () => {
      const config = {
        ...DEFAULT_CONFIG,
        [fieldName]: '',
      };

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledWith(expect.stringContaining(fieldName));
    });
  });

  describe.each([{ fieldName: 'env' as const }, { fieldName: 'version' as const }])(
    'optional field validation: $fieldName',
    ({ fieldName }) => {
      it('preserves provided value', () => {
        const config = {
          ...DEFAULT_CONFIG,
          [fieldName]: fieldName === 'env' ? 'production' : '1.0.0',
        };

        const result = buildConfiguration(config);

        expect(result?.[fieldName]).toBe(fieldName === 'env' ? 'production' : '1.0.0');
      });

      it.each([
        { value: '', description: 'empty string' },
        { value: null, description: 'null' },
        { value: undefined, description: 'undefined' },
        { value: 123, description: 'non-string value' },
      ])('treats $description as undefined', ({ value }) => {
        const config = {
          ...DEFAULT_CONFIG,
          [fieldName]: value,
        } as unknown as InitConfiguration;

        const result = buildConfiguration(config);

        expect(result?.[fieldName]).toBeUndefined();
      });
    }
  );

  describe('successful configuration', () => {
    it('builds config with required fields only', () => {
      const config = {
        ...DEFAULT_CONFIG,
      };

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.service).toBe('test-service');
      expect(result?.clientToken).toBe('test-token');
    });

    it('builds config with all fields', () => {
      const config = {
        ...DEFAULT_CONFIG,
        env: 'production',
        version: '1.0.0',
      };

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.service).toBe('test-service');
      expect(result?.clientToken).toBe('test-token');
      expect(result?.env).toBe('production');
      expect(result?.version).toBe('1.0.0');
    });

    it('builds config with some optional fields', () => {
      const config = {
        ...DEFAULT_CONFIG,
        env: 'staging',
      };

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.service).toBe('test-service');
      expect(result?.clientToken).toBe('test-token');
      expect(result?.env).toBe('staging');
      expect(result?.version).toBeUndefined();
    });
  });

  describe('site validation', () => {
    const VALID_DATADOG_SITES = [
      'datadoghq.com',
      'datadoghq.eu',
      'us3.datadoghq.com',
      'us5.datadoghq.com',
      'ap1.datadoghq.com',
      'ap2.datadoghq.com',
      'ddog-gov.com',
      'datad0g.com',
    ];

    it.each([
      { value: undefined, description: 'undefined' },
      { value: '', description: 'empty string' },
      { value: 123, description: 'number' },
      { value: null, description: 'null' },
      { value: 'invalid-site.com', description: 'invalid site' },
    ])('returns undefined and logs error when site is $description', ({ value }) => {
      const config = {
        ...DEFAULT_CONFIG,
        site: value,
      } as unknown as InitConfiguration;

      expect(buildConfiguration(config)).toBeUndefined();
      expect(display.displayError).toHaveBeenCalledWith(
        `Configuration error: 'site' must be one of: ${VALID_DATADOG_SITES.join(', ')}`
      );
    });

    it.each([
      { site: 'datadoghq.com', expectedUrl: 'https://browser-intake-datadoghq.com/api/v2/rum' },
      { site: 'datadoghq.eu', expectedUrl: 'https://browser-intake-datadoghq.eu/api/v2/rum' },
      { site: 'us3.datadoghq.com', expectedUrl: 'https://browser-intake-us3-datadoghq.com/api/v2/rum' },
      { site: 'us5.datadoghq.com', expectedUrl: 'https://browser-intake-us5-datadoghq.com/api/v2/rum' },
      { site: 'ap1.datadoghq.com', expectedUrl: 'https://browser-intake-ap1-datadoghq.com/api/v2/rum' },
      { site: 'ap2.datadoghq.com', expectedUrl: 'https://browser-intake-ap2-datadoghq.com/api/v2/rum' },
      { site: 'ddog-gov.com', expectedUrl: 'https://browser-intake-ddog-gov.com/api/v2/rum' },
      { site: 'datad0g.com', expectedUrl: 'https://browser-intake-datad0g.com/api/v2/rum' },
    ])('accepts valid site: $site', ({ site }) => {
      const config = {
        ...DEFAULT_CONFIG,
        site,
      };

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.site).toBe(site);
    });
  });

  describe('error logging', () => {
    it('logs error for missing service', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: undefined,
      } as unknown as InitConfiguration;

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledWith("Configuration error: 'service' must be a non-empty string");
    });

    it('logs error for empty clientToken', () => {
      const config = {
        ...DEFAULT_CONFIG,
        clientToken: '',
      };

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'clientToken' must be a non-empty string"
      );
    });

    it('includes field name in error message', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: 123,
      } as unknown as InitConfiguration;

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledWith(expect.stringContaining('service'));
    });

    it('logs multiple errors when multiple fields are invalid', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: '',
        clientToken: '',
      };

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledTimes(2);
      expect(display.displayError).toHaveBeenCalledWith("Configuration error: 'service' must be a non-empty string");
      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'clientToken' must be a non-empty string"
      );
    });
  });

  describe('defaultPrivacyLevel validation', () => {
    it('defaults to mask when not provided', () => {
      const config = { ...DEFAULT_CONFIG };

      const result = buildConfiguration(config);

      expect(result?.defaultPrivacyLevel).toBe('mask');
    });

    it.each(['mask', 'allow', 'mask-user-input'] as const)('accepts valid value: %s', (value) => {
      const config = { ...DEFAULT_CONFIG, defaultPrivacyLevel: value };

      const result = buildConfiguration(config);

      expect(result?.defaultPrivacyLevel).toBe(value);
    });

    it.each([
      { value: 'invalid', description: 'invalid string' },
      { value: 123, description: 'number' },
      { value: {}, description: 'object' },
    ])('logs error and uses default when $description', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, defaultPrivacyLevel: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.defaultPrivacyLevel).toBe('mask');
      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'defaultPrivacyLevel' must be one of: mask, allow, mask-user-input"
      );
    });

    it.each([
      { value: null, description: 'null' },
      { value: undefined, description: 'undefined' },
    ])('defaults to mask when $description (no error)', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, defaultPrivacyLevel: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.defaultPrivacyLevel).toBe('mask');
      expect(display.displayError).not.toHaveBeenCalled();
    });
  });

  describe('allowedWebViewHosts validation', () => {
    it('defaults to empty array when not provided', () => {
      const config = { ...DEFAULT_CONFIG };

      const result = buildConfiguration(config);

      expect(result?.allowedWebViewHosts).toEqual([]);
    });

    it('accepts valid array of strings', () => {
      const config = { ...DEFAULT_CONFIG, allowedWebViewHosts: ['example.com', 'other.com'] };

      const result = buildConfiguration(config);

      expect(result?.allowedWebViewHosts).toEqual(['example.com', 'other.com']);
    });

    it.each([
      { value: 'not-an-array', description: 'string' },
      { value: 123, description: 'number' },
      { value: [123, 456], description: 'array of non-strings' },
      { value: ['valid', 123], description: 'mixed array' },
    ])('logs error and uses default when $description', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, allowedWebViewHosts: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.allowedWebViewHosts).toEqual([]);
      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'allowedWebViewHosts' must be an array of strings"
      );
    });

    it.each([
      { value: null, description: 'null' },
      { value: undefined, description: 'undefined' },
    ])('defaults to empty array when $description (no error)', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, allowedWebViewHosts: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.allowedWebViewHosts).toEqual([]);
      expect(display.displayError).not.toHaveBeenCalled();
    });
  });

  describe('telemetrySampleRate validation', () => {
    it('defaults to 20 when not provided', () => {
      const config = { ...DEFAULT_CONFIG };

      const result = buildConfiguration(config);

      expect(result?.telemetrySampleRate).toBe(20);
    });

    it.each([0, 50, 100])('accepts valid value: %d', (value) => {
      const config = { ...DEFAULT_CONFIG, telemetrySampleRate: value };

      const result = buildConfiguration(config);

      expect(result?.telemetrySampleRate).toBe(value);
    });

    it.each([
      { value: -1, description: 'negative number' },
      { value: 101, description: 'greater than 100' },
      { value: 'fifty', description: 'non-number string' },
      { value: {}, description: 'object' },
    ])('logs error and uses default when $description', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, telemetrySampleRate: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.telemetrySampleRate).toBe(20);
      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'telemetrySampleRate' must be a number between 0 and 100"
      );
    });

    it.each([
      { value: null, description: 'null' },
      { value: undefined, description: 'undefined' },
    ])('defaults to 20 when $description (no error)', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, telemetrySampleRate: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.telemetrySampleRate).toBe(20);
      expect(display.displayError).not.toHaveBeenCalled();
    });
  });
});
