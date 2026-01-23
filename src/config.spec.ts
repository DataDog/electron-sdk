import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildConfiguration } from './config';
import type { InitConfiguration } from './config';

describe('buildConfiguration', () => {
  // Default valid config used as base for all tests
  const DEFAULT_CONFIG: InitConfiguration = {
    site: 'datadoghq.com',
    service: 'test-service',
    clientToken: 'test-token',
  };

  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe.each([{ fieldName: 'service' as const }, { fieldName: 'clientToken' as const }])(
    'required field validation: $fieldName',
    ({ fieldName }) => {
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

        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(fieldName));
      });
    }
  );

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
      expect(result?.intakeUrl).toBeDefined();
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
      expect(result?.intakeUrl).toBeDefined();
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
      expect(consoleErrorSpy).toHaveBeenCalledWith(
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
    ])('accepts valid site: $site', ({ site, expectedUrl }) => {
      const config = {
        ...DEFAULT_CONFIG,
        site,
      };

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.intakeUrl).toBe(expectedUrl);
    });
  });

  describe('error logging', () => {
    it('logs error for missing service', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: undefined,
      } as unknown as InitConfiguration;

      buildConfiguration(config);

      expect(consoleErrorSpy).toHaveBeenCalledWith("Configuration error: 'service' must be a non-empty string");
    });

    it('logs error for empty clientToken', () => {
      const config = {
        ...DEFAULT_CONFIG,
        clientToken: '',
      };

      buildConfiguration(config);

      expect(consoleErrorSpy).toHaveBeenCalledWith("Configuration error: 'clientToken' must be a non-empty string");
    });

    it('includes field name in error message', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: 123,
      } as unknown as InitConfiguration;

      buildConfiguration(config);

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('service'));
    });

    it('logs multiple errors when multiple fields are invalid', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: '',
        clientToken: '',
      };

      buildConfiguration(config);

      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith("Configuration error: 'service' must be a non-empty string");
      expect(consoleErrorSpy).toHaveBeenCalledWith("Configuration error: 'clientToken' must be a non-empty string");
    });
  });

  describe('intakeUrl computation', () => {
    it('uses proxy when provided (proxy takes precedence)', () => {
      const config = {
        ...DEFAULT_CONFIG,
        site: 'datadoghq.com',
        proxy: 'http://localhost:3000',
      };

      const result = buildConfiguration(config);

      expect(result?.intakeUrl).toBe('http://localhost:3000');
    });

    it('generates intakeUrl from site when proxy is not provided', () => {
      const config = {
        ...DEFAULT_CONFIG,
        site: 'datadoghq.eu',
      };

      const result = buildConfiguration(config);

      expect(result?.intakeUrl).toBe('https://browser-intake-datadoghq.eu/api/v2/rum');
    });
  });
});
