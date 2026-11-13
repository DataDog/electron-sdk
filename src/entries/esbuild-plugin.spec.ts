import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build, stop } from 'esbuild';
import { afterAll, expect, it, vi } from 'vitest';
import { datadogEsbuildPlugin } from './esbuild-plugin';

vi.mock('./sdk-runtime-assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdk-runtime-assets')>()),
  // Runtime asset emission is covered separately; this test builds the dependency factories in memory.
  emitSdkRuntimeAssets: vi.fn(),
}));

afterAll(() => stop());

for (const format of ['cjs', 'esm'] as const) {
  for (const bundledMode of [false, true]) {
    it.each([false, true])(
      `instruments dependencies in ${format} output with bundledMode=${bundledMode}, minify=%s`,
      async (minify) => verifyOutput({ format, bundledMode, minify, bundle: true })
    );
  }
  it(`transpiles ${format} without bundling or externalization options`, async () =>
    verifyOutput({ format, bundledMode: false, minify: false, bundle: false }));
}

async function verifyOutput(options: {
  format: 'cjs' | 'esm';
  bundledMode: boolean;
  minify: boolean;
  bundle: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'electron-esbuild-instrumentation-'));
  try {
    // Only package metadata and a tiny export are needed to exercise an upstream registered hook.
    const packageDirectory = join(directory, 'node_modules/dd-trace-api');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name: 'dd-trace-api', version: '1.0.1', type: 'commonjs' })
    );
    await writeFile(
      join(packageDirectory, 'index.js'),
      'module.exports = { marker: "bundled-module", handler: function namedOperation() {} };'
    );
    const entry = join(directory, 'entry.js');
    await writeFile(entry, 'import api from "dd-trace-api"; export default api;');
    const output = join(directory, options.format === 'esm' ? 'bundle.mjs' : 'bundle.cjs');
    const result = await build({
      entryPoints: [entry],
      outfile: output,
      bundle: options.bundle,
      platform: 'node',
      format: options.format,
      minify: options.minify,
      keepNames: false,
      write: false,
      logLevel: 'silent',
      // The temporary package is outside the application's installed tracer dependency tree.
      nodePaths: [join(process.cwd(), 'node_modules')],
      plugins: [datadogEsbuildPlugin({ bundledMode: options.bundledMode })],
    });
    await writeFile(output, result.outputFiles[0].contents);
    const runner = join(directory, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert = require('node:assert/strict');
const messages = [];
require('node:diagnostics_channel').channel('dd-trace:bundler:load').subscribe(message => messages.push(message));
void (async () => {
  const api = (await import(${JSON.stringify(output)})).default;
  // A CJS build of an ESM entry exposes its default through module.exports.default.
  const value = ${options.format === 'cjs' ? 'api.default' : 'api'};
  assert.equal(value.marker, 'bundled-module');
  assert.equal(value.handler.name, 'namedOperation');
  assert.equal(globalThis[Symbol.for('@datadog/electron-sdk:bundledMode')], ${options.bundledMode});
  assert.equal(messages.length, ${options.bundle ? 1 : 0});
  ${
    options.bundle
      ? `assert.equal(messages[0].module, value);
  assert.equal(messages[0].package, 'dd-trace-api');
  assert.equal(messages[0].version, '1.0.1');`
      : ''
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`
    );
    const child = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 10000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
