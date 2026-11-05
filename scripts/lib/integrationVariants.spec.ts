import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { materializeApp } from './compatibility.ts';
import { getIntegrationVariantEnvironment, loadIntegrationVariants } from './integrationVariants.ts';

it('covers external staging, external copying, and bundled output without redundant bundled copying', () => {
  const variants = loadIntegrationVariants();
  expect(variants.map((variant) => [variant.name, getIntegrationVariantEnvironment(variant)])).toEqual([
    ['default', { DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES: 'false', DD_ELECTRON_BUNDLED_MODE: 'false' }],
    ['plugin-copy', { DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES: 'true', DD_ELECTRON_BUNDLED_MODE: 'false' }],
    ['bundled', { DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES: 'false', DD_ELECTRON_BUNDLED_MODE: 'true' }],
  ]);
});

it('materializes normal variants without changing Electron or moving the SDK out of production dependencies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-variant-'));
  const source = path.join(root, 'source');
  const manifest = {
    dependencies: { '@datadog/electron-sdk': 'file:../../integration-sdk.tgz' },
    devDependencies: { electron: '41.1.0' },
  };
  try {
    await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(manifest));
    for (const variant of loadIntegrationVariants()) {
      const destination = path.join(root, variant.name);
      await materializeApp(source, destination, undefined, 'file:../../integration-sdk.tgz');
      expect(JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8'))).toEqual(manifest);
      expect(await fs.readdir(destination)).not.toContain('node_modules');
    }
    expect(JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'))).toEqual(manifest);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
