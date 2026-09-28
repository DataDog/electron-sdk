import { describe, it, expect } from 'vitest';
import { deriveExecutionContextName } from './deriveExecutionContextName';

describe('deriveExecutionContextName', () => {
  it('returns undefined for an empty URL', () => {
    expect(deriveExecutionContextName('')).toBeUndefined();
  });

  it('keeps only origin and path for a non-localhost http(s) URL', () => {
    expect(deriveExecutionContextName('https://example.com/foo/bar?x=1')).toBe('https://example.com/foo/bar');
    expect(deriveExecutionContextName('http://example.com/')).toBe('http://example.com/');
  });

  it('drops query, fragment, and credentials from a non-localhost http(s) URL (e.g. an OAuth redirect)', () => {
    expect(deriveExecutionContextName('https://user:pw@example.com/path?code=abc#access_token=xyz')).toBe(
      'https://example.com/path'
    );
  });

  it('strips scheme, host and port from localhost URLs, keeping path and query', () => {
    expect(deriveExecutionContextName('http://localhost:3000/foo/bar?x=1')).toBe('/foo/bar?x=1');
    expect(deriveExecutionContextName('http://127.0.0.1:3000/foo')).toBe('/foo');
    expect(deriveExecutionContextName('http://[::1]:3000/foo')).toBe('/foo');
  });

  it('recognizes the full loopback range, not just 127.0.0.1', () => {
    expect(deriveExecutionContextName('http://127.0.0.2:3000/foo')).toBe('/foo');
    expect(deriveExecutionContextName('http://127.255.255.254:3000/foo')).toBe('/foo');
    expect(deriveExecutionContextName('http://myapp.localhost:3000/foo')).toBe('/foo');
  });

  it('keeps the hash for hash-routed localhost and custom-protocol apps', () => {
    expect(deriveExecutionContextName('http://localhost:3000/#/settings')).toBe('/#/settings');
    expect(deriveExecutionContextName('app://app/#/dashboard')).toBe('/#/dashboard');
  });

  it('keeps only the filename for file:// URLs', () => {
    expect(deriveExecutionContextName('file:///Users/foo/app/dist/index.html')).toBe('index.html');
  });

  it('does not leak the full local path for a file:// directory URL (trailing slash)', () => {
    const name = deriveExecutionContextName('file:///Users/alice/Projects/acme-client/dist/');
    expect(name).toBe('dist');
    expect(name).not.toContain('alice');
  });

  it('falls back to the scheme, not the full url, for a file:// URL with no segment at all', () => {
    expect(deriveExecutionContextName('file:///')).toBe('file:');
  });

  it('strips scheme, host and port from custom app protocols with a host, keeping path and query', () => {
    expect(deriveExecutionContextName('app://app/')).toBe('/');
    expect(deriveExecutionContextName('app://app/secondary.html')).toBe('/secondary.html');
    expect(deriveExecutionContextName('devtools://devtools/bundled/inspector.html')).toBe('/bundled/inspector.html');
    expect(deriveExecutionContextName('chrome-extension://abcdefgh/background.html')).toBe('/background.html');
  });

  it('resolves an empty pathname on a hostful custom protocol to "/" instead of an empty string', () => {
    expect(deriveExecutionContextName('app://app')).toBe('/');
    expect(deriveExecutionContextName('foo://bar')).toBe('/');
    expect(deriveExecutionContextName('app://app')).not.toBe('');
  });

  it('keeps the last path segment for hostless schemes', () => {
    expect(deriveExecutionContextName('blob:https://example.com/550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000'
    );
  });

  it('returns undefined for about: so a transient window.open() blank document is not frozen as the name', () => {
    expect(deriveExecutionContextName('about:blank')).toBeUndefined();
  });

  it('falls back to the raw URL when it cannot be parsed', () => {
    expect(deriveExecutionContextName('not a url')).toBe('not a url');
  });

  it('truncates a name longer than 200 characters', () => {
    const longPath = `/${'a'.repeat(250)}`;
    const name = deriveExecutionContextName(`https://localhost${longPath}`);
    expect(name).toHaveLength(200);
    expect(name).toBe(longPath.slice(0, 200));
  });

  it('bounds a content-bearing hostless scheme (data:) instead of leaking its full content', () => {
    const name = deriveExecutionContextName(`data:text/plain,${'secret'.repeat(50)}`);
    expect(name).toHaveLength(200);
  });
});
