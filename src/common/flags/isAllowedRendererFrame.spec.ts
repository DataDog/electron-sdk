import { describe, it, expect } from 'vitest';
import { isAllowedRendererFrame } from '../../assembly';

describe('isAllowedRendererFrame', () => {
  it('matches the gate host rules: exact, subdomain, wildcard, file://, null origin with URL fallback', () => {
    // Wildcard allows everything
    expect(isAllowedRendererFrame({ origin: 'https://evil.com', url: 'https://evil.com' }, ['*'])).toBe(true);

    // Exact host
    expect(
      isAllowedRendererFrame({ origin: 'https://app.example.com', url: 'https://app.example.com' }, ['app.example.com'])
    ).toBe(true);
    expect(isAllowedRendererFrame({ origin: 'https://evil.com', url: 'https://evil.com' }, ['app.example.com'])).toBe(
      false
    );

    // Subdomain via wildcard
    expect(
      isAllowedRendererFrame({ origin: 'https://foo.staging.example.com', url: 'https://foo.staging.example.com' }, [
        '*.staging.example.com',
      ])
    ).toBe(true);

    // file:// origin normalized to ''
    expect(isAllowedRendererFrame({ origin: 'file://', url: 'file:///path' }, [''])).toBe(true);

    // Null origin (custom protocol) falls back to URL
    expect(isAllowedRendererFrame({ origin: 'null', url: 'app://frame/page' }, ['*'])).toBe(true);

    // Undefined frame rejected
    expect(isAllowedRendererFrame(undefined, ['*'])).toBe(false);
  });
});
