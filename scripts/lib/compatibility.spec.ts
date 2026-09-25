import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadCompatibilityConfig, materializeApp } from './compatibility.ts';
import { generateCompatibilityCi, parseCompatibilityCiFilters } from './compatibilityCi.ts';

it.each(['electron', 'electron-nightly'])(
  'materializes %s without changing the template or copying build artifacts',
  async (dependency) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compatibility-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'generated');
    const manifest = {
      dependencies: { '@datadog/electron-sdk': 'portal:../..', other: '1.0.0' },
      devDependencies: { electron: '41.1.0' },
    };
    try {
      await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
      await fs.mkdir(path.join(source, 'dist'));
      await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(manifest));
      await fs.writeFile(path.join(source, 'main.ts'), 'local source');
      await fs.writeFile(path.join(source, '.yarnrc.yml'), 'npmPreapprovedPackages:\n  - dd-trace@6.10.0\n');
      await materializeApp(
        source,
        destination,
        { id: 'test', dependency, version: '42.0.0', channel: 'stable' },
        'file:../sdk.tgz'
      );
      const result = JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8'));
      expect(result.dependencies).toEqual({ '@datadog/electron-sdk': 'file:../sdk.tgz', other: '1.0.0' });
      expect(result.devDependencies.electron).toBe(
        dependency === 'electron' ? '42.0.0' : 'npm:electron-nightly@42.0.0'
      );
      expect(await fs.readFile(path.join(destination, 'main.ts'), 'utf8')).toBe('local source');
      const entries = await fs.readdir(destination);
      expect(entries).not.toContain('dist');
      expect(entries).not.toContain('node_modules');
      expect(await fs.readFile(path.join(destination, '.yarnrc.yml'), 'utf8')).toContain(
        `  - ${dependency}@42.0.0\n  - dd-trace@6.10.0`
      );
      expect(JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'))).toEqual(manifest);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

it('generates the Linux/macOS matrix, preserves failure reporting, and validates CI selections', () => {
  const config = loadCompatibilityConfig();
  const yaml = generateCompatibilityCi(config);
  expect(yaml.match(/^\w+:electron-[^:]+:/gm)).toHaveLength(config.targets.length * 2);
  expect(yaml).toContain('xvfb-run -a yarn test:compatibility');
  expect(yaml).toContain('macos:sequoia-arm64');
  expect(yaml).toContain('set -o pipefail');
  expect(yaml).toContain('npm_config_cache:');
  expect(yaml).not.toContain('windows');
  const filtered = generateCompatibilityCi(
    config,
    parseCompatibilityCiFilters(config, {
      DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS: 'macos',
      DD_ELECTRON_COMPATIBILITY_TARGETS: 'electron-41',
    })
  );
  expect(filtered.match(/^\w+:electron-[^:]+:/gm)).toEqual(['macos:electron-41:']);
  expect(filtered).not.toContain('xvfb-run');
  expect(() => parseCompatibilityCiFilters(config, { DD_ELECTRON_COMPATIBILITY_TARGETS: '../unknown' })).toThrow(
    'Unknown compatibility selection'
  );
});
