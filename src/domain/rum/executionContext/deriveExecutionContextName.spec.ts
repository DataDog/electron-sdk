import { describe, it, expect } from 'vitest';
import { deriveExecutionContextName } from './deriveExecutionContextName';

describe('deriveExecutionContextName', () => {
  it('returns undefined for an empty URL', () => {
    expect(deriveExecutionContextName('')).toBeUndefined();
  });

  it('keeps a non-localhost http(s) URL unchanged', () => {
    expect(deriveExecutionContextName('https://example.com/foo/bar?x=1')).toBe('https://example.com/foo/bar?x=1');
    expect(deriveExecutionContextName('http://example.com/')).toBe('http://example.com/');
  });

  it('strips scheme, host and port from localhost URLs, keeping path and query', () => {
    expect(deriveExecutionContextName('http://localhost:3000/foo/bar?x=1')).toBe('/foo/bar?x=1');
    expect(deriveExecutionContextName('http://127.0.0.1:3000/foo')).toBe('/foo');
    expect(deriveExecutionContextName('http://[::1]:3000/foo')).toBe('/foo');
  });

  it('keeps the hash for hash-routed localhost and custom-protocol apps', () => {
    expect(deriveExecutionContextName('http://localhost:3000/#/settings')).toBe('/#/settings');
    expect(deriveExecutionContextName('app://app/#/dashboard')).toBe('/#/dashboard');
  });

  it('keeps only the filename for file:// URLs', () => {
    expect(deriveExecutionContextName('file:///Users/foo/app/dist/index.html')).toBe('index.html');
  });

  it('strips scheme, host and port from custom app protocols with a host, keeping path and query', () => {
    expect(deriveExecutionContextName('app://app/')).toBe('/');
    expect(deriveExecutionContextName('app://app/secondary.html')).toBe('/secondary.html');
    expect(deriveExecutionContextName('devtools://devtools/bundled/inspector.html')).toBe('/bundled/inspector.html');
    expect(deriveExecutionContextName('chrome-extension://abcdefgh/background.html')).toBe('/background.html');
  });

  it('keeps the last path segment for hostless schemes', () => {
    expect(deriveExecutionContextName('about:blank')).toBe('about:blank');
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
