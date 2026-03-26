import { describe, it, expect } from 'vitest';
import { bumpVersion } from './semver.ts';

describe('bumpVersion', () => {
  it('bumps patch', () => expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4'));
  it('bumps minor and resets patch', () => expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0'));
  it('bumps major and resets minor+patch', () => expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0'));
  it('handles 0.x versions', () => expect(bumpVersion('0.1.0', 'minor')).toBe('0.2.0'));
  it('throws on invalid semver', () => expect(() => bumpVersion('not-semver', 'patch')).toThrow());
});
