import { describe, expect, it } from 'vitest';

import {
  getCompatibilityTarget,
  getElectronDependencySpecifier,
  loadCompatibilityConfig,
  updatePackageManifest,
  validateCompatibilityConfig,
} from './compatibility.ts';

describe('compatibility config', () => {
  it('loads explicit Electron targets and extensible app variants', () => {
    const config = loadCompatibilityConfig();

    expect(config.targets.map(({ id }) => id)).toEqual([
      'electron-39',
      'electron-40',
      'electron-41',
      'electron-42',
      'electron-43',
      'electron-44-prerelease',
      'electron-45-nightly',
    ]);
    expect(config.environments.map(({ id }) => id)).toEqual(['linux', 'macos', 'windows']);
    expect(config.targets.find(({ id }) => id === 'electron-45-nightly')?.ci?.allowFailure).toBe(true);
    for (const template of config.appTemplates.filter(({ kind }) => kind === 'integration')) {
      expect(template.variants).toEqual([
        {
          id: 'default',
          parameters: { runtimeDependencyStrategy: 'plugin-copy' },
          modes: ['dev', 'packaged'],
        },
        {
          id: 'packager-copy',
          parameters: { runtimeDependencyStrategy: 'packager-copy' },
          modes: ['packaged'],
        },
      ]);
    }
  });

  it('supports an npm alias for Electron nightly', () => {
    const config = loadCompatibilityConfig();
    const target = getCompatibilityTarget(config, 'electron-45-nightly');

    expect(getElectronDependencySpecifier(target)).toBe('npm:electron-nightly@45.0.0-nightly.20260814');
  });

  it('updates a generated app manifest without dropping its dependencies', () => {
    expect(
      updatePackageManifest(
        {
          dependencies: { existing: '1.0.0', '@datadog/electron-sdk': 'portal:../..' },
          devDependencies: { electron: '41.1.0', typescript: '5.9.3' },
        },
        '39.8.10',
        'file:../compatibility-sdk.tgz'
      )
    ).toEqual({
      dependencies: {
        existing: '1.0.0',
        '@datadog/electron-sdk': 'file:../compatibility-sdk.tgz',
      },
      devDependencies: { electron: '39.8.10', typescript: '5.9.3' },
    });
  });

  it('rejects override selectors and paths that cannot be applied safely', () => {
    const config = loadCompatibilityConfig();
    expect(() =>
      validateCompatibilityConfig({
        ...config,
        overrides: [
          {
            id: 'bad-override',
            when: { targets: ['electron-unknown'], templates: ['minimal-e2e'] },
            source: '../outside',
          },
        ],
      })
    ).toThrow('unknown target');

    expect(() =>
      validateCompatibilityConfig({
        ...config,
        overrides: [
          {
            id: 'bad-override',
            when: { targets: ['electron-39'], templates: ['minimal-e2e'] },
            source: '../outside',
          },
        ],
      })
    ).toThrow('Invalid source');
  });
});
