import { describe, it, expect } from 'vitest';
import { resolvePlaygroundVersion } from './version.ts';

describe('resolvePlaygroundVersion', () => {
  it('uses PLAYGROUND_VERSION when set', () => {
    expect(resolvePlaygroundVersion({ PLAYGROUND_VERSION: '0.1.2' }, () => 'abc123')).toBe('0.1.2');
  });

  it('trims PLAYGROUND_VERSION', () => {
    expect(resolvePlaygroundVersion({ PLAYGROUND_VERSION: ' 0.1.2 \n' }, () => 'abc123')).toBe('0.1.2');
  });

  it('falls back to the git sha when PLAYGROUND_VERSION is unset', () => {
    expect(resolvePlaygroundVersion({}, () => 'abc123')).toBe('abc123');
  });

  it('treats a blank PLAYGROUND_VERSION as unset', () => {
    expect(resolvePlaygroundVersion({ PLAYGROUND_VERSION: '  ' }, () => 'abc123')).toBe('abc123');
  });

  it('falls back to "dev" when git is unavailable', () => {
    expect(resolvePlaygroundVersion({}, () => undefined)).toBe('dev');
  });
});
