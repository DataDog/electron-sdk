import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadCompatibilityConfig, type CompatibilityConfig } from './compatibility.ts';
import { applyCompatibilityOverrides } from './compatibilityOverrides.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('compatibility overrides', () => {
  it('applies matching overlays in order and then removes configured paths', () => {
    const repositoryRoot = createTemporaryDirectory();
    const destination = path.join(repositoryRoot, 'generated-app');
    const firstOverride = path.join(repositoryRoot, 'overrides/first');
    const secondOverride = path.join(repositoryRoot, 'overrides/second');
    fs.mkdirSync(path.join(destination, 'src'), { recursive: true });
    fs.mkdirSync(path.join(firstOverride, 'src'), { recursive: true });
    fs.mkdirSync(path.join(secondOverride, 'src'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'src/main.ts'), 'base');
    fs.writeFileSync(path.join(destination, 'src/remove.ts'), 'remove me');
    fs.writeFileSync(path.join(firstOverride, 'src/main.ts'), 'first');
    fs.writeFileSync(path.join(firstOverride, 'src/added.ts'), 'added');
    fs.writeFileSync(path.join(secondOverride, 'src/main.ts'), 'second');

    const config = withOverrides([
      {
        id: 'first',
        when: { targets: ['electron-39'], templates: ['forge-webpack'] },
        source: 'overrides/first',
      },
      {
        id: 'second',
        when: { targets: ['electron-39'], templates: ['forge-webpack'] },
        source: 'overrides/second',
        remove: ['src/remove.ts'],
      },
    ]);

    expect(
      applyCompatibilityOverrides(config, 'electron-39', 'forge-webpack', destination, repositoryRoot)
    ).toHaveLength(2);
    expect(fs.readFileSync(path.join(destination, 'src/main.ts'), 'utf8')).toBe('second');
    expect(fs.readFileSync(path.join(destination, 'src/added.ts'), 'utf8')).toBe('added');
    expect(fs.existsSync(path.join(destination, 'src/remove.ts'))).toBe(false);
  });

  it('does not apply an override to a different target or template', () => {
    const repositoryRoot = createTemporaryDirectory();
    const destination = path.join(repositoryRoot, 'generated-app');
    fs.mkdirSync(destination, { recursive: true });
    const config = withOverrides([
      {
        id: 'electron-39-forge-webpack',
        when: { targets: ['electron-39'], templates: ['forge-webpack'] },
        source: 'unused',
      },
    ]);

    expect(applyCompatibilityOverrides(config, 'electron-40', 'forge-webpack', destination, repositoryRoot)).toEqual(
      []
    );
    expect(applyCompatibilityOverrides(config, 'electron-39', 'forge-vite', destination, repositoryRoot)).toEqual([]);
  });
});

function withOverrides(overrides: CompatibilityConfig['overrides']): CompatibilityConfig {
  return { ...loadCompatibilityConfig(), overrides };
}

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compatibility-overrides-'));
  temporaryDirectories.push(directory);
  return directory;
}
