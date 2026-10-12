import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps the packaged WASM chunk lazy in CJS and ESM, with portable stable chunk names', () => {
  // Use the real build configuration in plain Node, without Vitest's module transforms.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      String.raw`
    import assert from 'node:assert/strict';
    import { rollup } from 'rollup';
    import configs from './rollup.config.mjs';
    import pkg from './package.json' with { type: 'json' };
    const { output, ...input } = configs[0];
    const bundle = await rollup(input);
    try {
      for (const settings of output) {
        assert.equal(settings.manualChunks('C:\\sdk\\src\\wasm\\index.ts'), 'wasm');
        const { output: files } = await bundle.generate(settings);
        const chunks = files.filter(file => file.type === 'chunk');
        const entry = chunks.find(chunk => chunk.isEntry);
        const extension = settings.format === 'cjs' ? 'cjs' : 'mjs';
        const wasmFile = 'wasm.chunk.' + extension;
        assert.ok(chunks.some(chunk => chunk.fileName === wasmFile), 'Missing stable WASM chunk');
        assert.ok(pkg.files.includes('dist/' + wasmFile), 'WASM chunk missing from package allowlist');
        assert.ok(entry.dynamicImports.includes(wasmFile), 'Missing lazy WASM import');
        const visited = new Set();
        function visit(chunk) {
          assert.notEqual(chunk.fileName, wasmFile, 'SDK statically imports the WASM chunk');
          if (visited.has(chunk.fileName)) return;
          visited.add(chunk.fileName);
          for (const name of chunk.imports) {
            const dependency = chunks.find(chunk => chunk.fileName === name);
            if (dependency) visit(dependency);
          }
        }
        visit(entry);
      }
    } finally {
      await bundle.close();
    }
  `,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 60000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 65000);
