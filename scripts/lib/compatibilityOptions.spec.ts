import { describe, expect, it } from 'vitest';

import { loadCompatibilityConfig } from './compatibility.ts';
import {
  parseCompatibilityPreparationOptions,
  parseCompatibilityRunOptions,
  selectCompatibilityPlaywrightProjects,
} from './compatibilityOptions.ts';

describe('compatibility preparation options', () => {
  it('uses the current checkout when no SDK source override is supplied', () => {
    expect(parseCompatibilityPreparationOptions(['electron-41'], {})).toMatchObject({
      targetId: 'electron-41',
      sdkRef: null,
      sdkTarball: null,
    });
  });

  it('reads an SDK ref from the environment and lets the CLI override it', () => {
    expect(
      parseCompatibilityPreparationOptions(['electron-41'], { DD_ELECTRON_SDK_GIT_REF: 'sdk-from-ui' }).sdkRef
    ).toBe('sdk-from-ui');
    expect(
      parseCompatibilityPreparationOptions(['electron-41', '--sdk-ref', 'sdk-from-cli'], {
        DD_ELECTRON_SDK_GIT_REF: 'sdk-from-ui',
      }).sdkRef
    ).toBe('sdk-from-cli');
  });

  it('lets a tarball override the environment but rejects two explicit SDK sources', () => {
    expect(
      parseCompatibilityPreparationOptions(['electron-41', '--sdk-tarball', 'sdk.tgz'], {
        DD_ELECTRON_SDK_GIT_REF: 'sdk-from-ui',
      })
    ).toMatchObject({ sdkTarball: 'sdk.tgz', sdkRef: null });
    expect(() =>
      parseCompatibilityPreparationOptions(['electron-41', '--sdk-tarball', 'sdk.tgz', '--sdk-ref', 'sdk-from-cli'])
    ).toThrow('cannot be used together');
  });
});

describe('compatibility run options', () => {
  it('leaves a bare command unfiltered so Playwright runs the complete suite', () => {
    const options = parseCompatibilityRunOptions(['electron-41']);

    expect(options).toEqual({
      targetId: 'electron-41',
      templateId: null,
      variantId: null,
      mode: null,
      playwrightArguments: [],
    });
    expect(selectCompatibilityPlaywrightProjects(loadCompatibilityConfig(), options)).toEqual([]);
  });

  it('selects the default variant and all of its modes when only a template is supplied', () => {
    const options = parseCompatibilityRunOptions(['electron-41', '--template=electron-builder-vite']);

    expect(selectCompatibilityPlaywrightProjects(loadCompatibilityConfig(), options)).toEqual([
      'electron-builder-vite-dev',
      'electron-builder-vite-packaged',
    ]);
  });

  it('selects one explicit variant and mode', () => {
    const options = parseCompatibilityRunOptions([
      'electron-41',
      '--template',
      'electron-builder-vite',
      '--variant',
      'packager-copy',
      '--mode',
      'packaged',
      '--grep=dependency copying',
    ]);

    expect(options.playwrightArguments).toEqual(['--grep=dependency copying']);
    expect(selectCompatibilityPlaywrightProjects(loadCompatibilityConfig(), options)).toEqual([
      'electron-builder-vite-packager-copy-packaged',
    ]);
  });

  it('maps the minimal E2E template to its Playwright project', () => {
    const options = parseCompatibilityRunOptions(['electron-41', '--template', 'minimal-e2e']);

    expect(selectCompatibilityPlaywrightProjects(loadCompatibilityConfig(), options)).toEqual(['e2e']);
  });

  it.each([
    { option: '--template', first: 'forge-webpack', second: 'forge-vite', prefix: [] },
    { option: '--variant', first: 'default', second: 'other', prefix: ['--template=forge-webpack'] },
    { option: '--mode', first: 'dev', second: 'packaged', prefix: ['--template=forge-webpack'] },
  ])('rejects a repeated $option selector', ({ option, first, second, prefix }) => {
    expect(() =>
      parseCompatibilityRunOptions(['electron-41', ...prefix, `${option}=${first}`, option, second])
    ).toThrow(`${option} may only be specified once`);
  });

  it('rejects variant and mode selectors without a template', () => {
    expect(() => parseCompatibilityRunOptions(['electron-41', '--variant=default'])).toThrow('require --template');
    expect(() => parseCompatibilityRunOptions(['electron-41', '--mode=packaged'])).toThrow('require --template');
  });

  it('rejects mixing compatibility selectors with Playwright projects', () => {
    expect(() =>
      parseCompatibilityRunOptions(['electron-41', '--template=forge-webpack', '--project=forge-webpack-dev'])
    ).toThrow('cannot be combined');
  });

  it('continues to support Playwright project selection when no compatibility selector is used', () => {
    const options = parseCompatibilityRunOptions(['electron-41', '--project=forge-webpack-dev']);

    expect(options.playwrightArguments).toEqual(['--project=forge-webpack-dev']);
    expect(selectCompatibilityPlaywrightProjects(loadCompatibilityConfig(), options)).toEqual([]);
  });

  it('reports unknown templates, variants, and modes with their available values', () => {
    const config = loadCompatibilityConfig();

    expect(() =>
      selectCompatibilityPlaywrightProjects(config, parseCompatibilityRunOptions(['electron-41', '--template=unknown']))
    ).toThrow('Available templates');
    expect(() =>
      selectCompatibilityPlaywrightProjects(
        config,
        parseCompatibilityRunOptions(['electron-41', '--template=forge-webpack', '--variant=unknown'])
      )
    ).toThrow('Available variants: default');
    expect(() =>
      selectCompatibilityPlaywrightProjects(
        config,
        parseCompatibilityRunOptions(['electron-41', '--template=electron-builder-vite', '--mode=unknown'])
      )
    ).toThrow('Available modes: dev, packaged');
  });
});
