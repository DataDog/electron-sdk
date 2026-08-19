import { describe, expect, it } from 'vitest';

import { loadCompatibilityConfig } from './compatibility.ts';
import { generateCompatibilityCi } from './compatibilityCi.ts';

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

    expect(ci).toContain('xvfb-run -a yarn test:compatibility electron-39');
    expect(ci).toContain('macos:electron-41:\n  stage: test\n  interruptible: true');
    expect(ci).toMatch(/windows:electron-45-nightly:[\s\S]*?allow_failure: true/);
  });
});
