import { describe, it, expect } from 'vitest';
import { categorizeCommit, generateChangelogSection } from './changelog.ts';

describe('categorizeCommit', () => {
  it('categorizes ✨ as features', () => expect(categorizeCommit('✨ add new thing')).toBe('features'));
  it('categorizes 🐛 as bugfixes', () => expect(categorizeCommit('🐛 fix crash')).toBe('bugfixes'));
  it('categorizes 💥 as breaking', () => expect(categorizeCommit('💥 remove API')).toBe('breaking'));
  it('categorizes 📝 as documentation', () => expect(categorizeCommit('📝 update README')).toBe('documentation'));
  it('categorizes ⚡ as performance', () => expect(categorizeCommit('⚡ speed up init')).toBe('performance'));
  it('categorizes 🔒 as security', () => expect(categorizeCommit('🔒 fix XSS')).toBe('security'));
  it('categorizes 👷 (other known gitmoji) as internal', () =>
    expect(categorizeCommit('👷 update CI')).toBe('internal'));
  it('categorizes ♻️ as internal', () => expect(categorizeCommit('♻️ refactor transport')).toBe('internal'));
  it('categorizes plain text (no emoji) as internal', () => expect(categorizeCommit('update deps')).toBe('internal'));
  it('categorizes Bump messages as internal', () =>
    expect(categorizeCommit('Bump electron from 40 to 41')).toBe('internal'));
});

describe('generateChangelogSection', () => {
  it('produces a section with public and internal commits', () => {
    const commits = ['✨ add init', '🐛 fix crash', '👷 update CI', 'update deps'];
    const result = generateChangelogSection('1.0.0', '2026-03-23', commits);
    expect(result).toContain('## [1.0.0] - 2026-03-23');
    expect(result).toContain('### ✨ Features');
    expect(result).toContain('- ✨ add init');
    expect(result).toContain('### 🐛 Bug Fixes');
    expect(result).toContain('- 🐛 fix crash');
    expect(result).toContain('### Internal');
    expect(result).toContain('- 👷 update CI');
    expect(result).toContain('- update deps');
  });

  it('omits empty categories', () => {
    const result = generateChangelogSection('1.0.0', '2026-03-23', ['✨ add thing']);
    expect(result).not.toContain('### 🐛 Bug Fixes');
    expect(result).not.toContain('### Internal');
  });

  it('excludes release commits (bare vX.Y.Z)', () => {
    const commits = ['✨ add thing', 'v0.9.0', '0.9.0'];
    const result = generateChangelogSection('1.0.0', '2026-03-23', commits);
    expect(result).not.toContain('v0.9.0');
    expect(result).not.toContain('0.9.0');
  });

  it('always puts Internal section last', () => {
    const commits = ['👷 CI update', '✨ add feature'];
    const result = generateChangelogSection('1.0.0', '2026-03-23', commits);
    expect(result.indexOf('### ✨ Features')).toBeLessThan(result.indexOf('### Internal'));
  });
});
