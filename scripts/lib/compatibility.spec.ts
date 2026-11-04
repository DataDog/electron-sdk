import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadCompatibilityConfig, materializeApp } from './compatibility.ts';
import { environments, generateCompatibilityCi, parseCompatibilityCiFilters } from './compatibilityCi.ts';

it.each(['electron', 'electron-nightly'])(
  'materializes %s without changing the template or copying build artifacts',
  async (dependency) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compatibility-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'generated');
    const packageJsonContent = {
      dependencies: { '@datadog/electron-sdk': 'portal:../..', other: '1.0.0' },
      devDependencies: { electron: '41.1.0' },
    };
    try {
      await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
      await fs.mkdir(path.join(source, 'dist'));
      await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(packageJsonContent));
      await fs.writeFile(path.join(source, 'main.ts'), 'local source');
      await fs.writeFile(path.join(source, '.yarnrc.yml'), 'npmPreapprovedPackages:\n  - dd-trace-electron\n');
      await materializeApp(source, destination, { id: 'test', dependency, version: '42.0.0' }, 'file:../sdk.tgz');
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
        `  - ${dependency}@42.0.0\n  - dd-trace-electron`
      );
      expect(JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'))).toEqual(packageJsonContent);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

it('generates structured jobs for every platform and preserves failure reporting', () => {
  const config = loadCompatibilityConfig();
  const pipeline = parse(generateCompatibilityCi(config));
  expect(pipeline.stages).toEqual(['test']);
  expect(Object.keys(pipeline)).toHaveLength(1 + config.targets.length * environments.length);
  for (const environment of environments) {
    for (const target of config.targets) {
      const job = pipeline[`${environment.id}:${target.id}`];
      expect(job).toMatchObject({ stage: 'test', interruptible: true, timeout: '2h', tags: environment.runnerTags });
      expect(job.image).toBe(environment.image);
      expect(job.allow_failure).toBeUndefined();
    }
  }

  const linux = pipeline['linux:electron-41'];
  const macos = pipeline['macos:electron-41'];
  const windows = pipeline['windows:electron-41'];
  for (const [job, prefix] of [
    [linux, 'xvfb-run -a '],
    [macos, ''],
  ] as const) {
    expect(job.variables).toEqual({
      YARN_ENABLE_INLINE_BUILDS: 'true',
      npm_config_cache: '$CI_PROJECT_DIR/.npm-cache/$CI_JOB_ID',
    });
    expect(job.script).toEqual([
      'mkdir -p logs',
      'set -o pipefail',
      'ELECTRON_SKIP_BINARY_DOWNLOAD=1 yarn install --immutable 2>&1 | tee logs/01-yarn-install.log',
      'yarn test:compatibility:init electron-41 2>&1 | tee logs/02-compatibility-init.log',
      `${prefix}yarn test:compatibility electron-41 2>&1 | tee logs/03-compatibility-tests.log`,
    ]);
    expect(job.after_script).toBeUndefined();
    expect(job.artifacts).toEqual({
      when: 'always',
      paths: ['logs/', 'test-results/', 'playwright-report/', 'e2e/compatibility/generated/*/metadata.json'],
    });
  }
  expect(windows.variables).toEqual({ YARN_ENABLE_INLINE_BUILDS: 'true', OVERRIDE_GIT_STRATEGY: 'clone' });
  expect(windows.script).toEqual([
    'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ci/windows/run.ps1 -Target electron-41',
  ]);
  expect(windows.after_script).toEqual([
    "$ErrorActionPreference = 'Continue'\n" +
      'docker rm --force "electron-sdk-tests-$env:CI_JOB_ID" 2>$null\n' +
      'docker image rm --no-prune "electron-sdk-windows-tests:$env:CI_JOB_ID" 2>$null\n' +
      '$global:LASTEXITCODE = 0\n',
  ]);
  expect(windows.artifacts).toEqual({ when: 'always', paths: ['windows-test-artifacts/'] });
});

it('filters jobs and rejects unknown CI selections', () => {
  const config = loadCompatibilityConfig();
  const filtered = parse(
    generateCompatibilityCi(
      config,
      parseCompatibilityCiFilters(config, {
        DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS: 'macos',
        DD_ELECTRON_COMPATIBILITY_TARGETS: 'electron-41',
      })
    )
  );
  expect(Object.keys(filtered)).toEqual(['stages', 'macos:electron-41']);
  expect(() => parseCompatibilityCiFilters(config, { DD_ELECTRON_COMPATIBILITY_TARGETS: '../unknown' })).toThrow(
    'Unknown compatibility selection'
  );
  expect(() => parseCompatibilityCiFilters(config, { DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS: 'unknown' })).toThrow(
    'Unknown compatibility selection'
  );
});

it('preserves strings requiring YAML quoting in both YAML versions', () => {
  const config = loadCompatibilityConfig();
  const environment = {
    ...environments[0],
    runnerTags: ['on', 'true', '001', "runner's tag: #1"],
    image: 'registry.example/image:tag #literal',
  };
  const yaml = generateCompatibilityCi(config, { environments: [environment], targets: [config.targets[0]] });
  for (const version of ['1.1', '1.2'] as const) {
    const job = parse(yaml, { version })[`linux:${config.targets[0].id}`];
    expect(job.tags).toEqual(environment.runnerTags);
    expect(job.image).toBe(environment.image);
    expect(job.variables.YARN_ENABLE_INLINE_BUILDS).toBe('true');
  }
});
