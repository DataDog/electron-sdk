import { describe, expect, it } from 'vitest';

import { loadCompatibilityConfig } from './compatibility.ts';
import { generateCompatibilityCi, parseCompatibilityCiFilters } from './compatibilityCi.ts';

describe('compatibility CI generator', () => {
  it('generates every configured environment and target combination', () => {
    const config = loadCompatibilityConfig();
    const ci = generateCompatibilityCi(config);

    for (const environment of config.environments) {
      for (const target of config.targets) {
        expect(ci).toContain(`${environment.id}:${target.id}:`);
      }
    }
    expect(ci.match(/^\w[\w-]*:electron-[\w-]+:$/gm)).toHaveLength(config.environments.length * config.targets.length);
  });

  it('uses platform-specific launch commands and keeps nightly non-blocking', () => {
    const ci = generateCompatibilityCi(loadCompatibilityConfig());

    expect(ci).toContain('-- xvfb-run -a yarn test:compatibility electron-39');
    expect(ci).toContain('macos:electron-41:\n  stage: test\n  interruptible: true');
    expect(ci).toMatch(/windows:electron-45-nightly:[\s\S]*?allow_failure: true/);
  });

  it('preserves phase logs and retries dependency installation', () => {
    const ci = generateCompatibilityCi(loadCompatibilityConfig());

    expect(ci).toContain("YARN_ENABLE_INLINE_BUILDS: 'true'");
    expect(ci).toContain(
      '--log logs/01-yarn-install.log --env ELECTRON_SKIP_BINARY_DOWNLOAD=1 --retry-delay 2000 --retry-delay 5000'
    );
    expect(ci).toContain('--log logs/02-compatibility-init.log');
    expect(ci).toContain('--log logs/03-compatibility-tests.log');
    expect(ci).toContain('  artifacts:\n    when: always\n    paths:\n      - logs/');
  });

  it('filters environments and targets from comma-separated pipeline variables', () => {
    const config = loadCompatibilityConfig();
    const filters = parseCompatibilityCiFilters(config, {
      DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS: ' linux, macos,linux ',
      DD_ELECTRON_COMPATIBILITY_TARGETS: 'electron-41',
    });
    const ci = generateCompatibilityCi(config, filters);

    expect(filters).toEqual({
      environmentIds: ['linux', 'macos'],
      targetIds: ['electron-41'],
    });
    expect(ci).toContain('linux:electron-41:');
    expect(ci).toContain('macos:electron-41:');
    expect(ci).not.toContain('windows:electron-41:');
    expect(ci).not.toContain('linux:electron-40:');
    expect(ci.match(/^\w[\w-]*:electron-[\w-]+:$/gm)).toHaveLength(2);
  });

  it('treats omitted or blank filters as the complete matrix', () => {
    const config = loadCompatibilityConfig();

    expect(parseCompatibilityCiFilters(config, {})).toEqual({
      environmentIds: undefined,
      targetIds: undefined,
    });
    expect(
      parseCompatibilityCiFilters(config, {
        DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS: ' ',
        DD_ELECTRON_COMPATIBILITY_TARGETS: '',
      })
    ).toEqual({ environmentIds: undefined, targetIds: undefined });
  });

  it('rejects unknown or malformed filter values', () => {
    const config = loadCompatibilityConfig();

    expect(() =>
      parseCompatibilityCiFilters(config, { DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS: 'linux,unknown' })
    ).toThrow('Unknown compatibility environment(s)');
    expect(() => parseCompatibilityCiFilters(config, { DD_ELECTRON_COMPATIBILITY_TARGETS: 'electron-41,' })).toThrow(
      'without empty target identifiers'
    );
  });
});
