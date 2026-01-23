import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { init } from './index';
import type { InitConfiguration } from './config';

describe('init', () => {
  // Default valid config used as base for all tests
  const DEFAULT_CONFIG: InitConfiguration = {
    site: 'datadoghq.com',
    proxy: 'http://localhost:3000',
    clientToken: 'test-token',
    service: 'test-service',
    applicationId: 'test-app-id',
  };

  let consoleErrorSpy: any;

  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
      } as Response)
    );
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should return true', () => {
    const config = {
      ...DEFAULT_CONFIG,
    };
    expect(init(config)).toBe(true);
  });

  it('should call fetch with correct parameters', async () => {
    const config = {
      ...DEFAULT_CONFIG,
    };

    init(config);

    // Wait for the async sendEvent call to complete
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'DD-API-KEY': 'test-token',
        },
        body: expect.stringContaining('"service":"test-service"') as string,
      })
    );
  });

  describe('configuration validation', () => {
    it('returns false when a required property is empty', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: '',
      };

      expect(init(config)).toBe(false);
    });

    it('returns false when a required property is missing', () => {
      const config = {
        ...DEFAULT_CONFIG,
        clientToken: undefined,
      } as unknown as InitConfiguration;

      expect(init(config)).toBe(false);
    });

    it('returns true when an optional property is missing', () => {
      const config = {
        ...DEFAULT_CONFIG,
        proxy: undefined,
      };

      expect(init(config)).toBe(true);
    });

    it('logs configuration error message', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: '',
      };

      init(config);

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('service'));
    });
  });
});
