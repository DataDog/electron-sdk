import { describe, it, expect, vi, beforeEach } from 'vitest';
import { init } from './index';

describe('init', () => {
  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
      } as Response)
    );
  });

  it('should return true', () => {
    const config = {
      proxy: 'http://localhost:3000',
      clientToken: 'test-token',
      service: 'test-service',
    };
    expect(init(config)).toBe(true);
  });

  it('should call fetch with correct parameters', async () => {
    const config = {
      proxy: 'http://localhost:3000',
      clientToken: 'test-token',
      service: 'test-service',
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
});
