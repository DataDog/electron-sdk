import { describe, it, expect } from 'vitest';
import { rollup, type RollupOptions } from 'rollup';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore the rollup config is plain ESM JavaScript
import rollupConfig from '../../rollup.config.mjs';

/**
 * `MessageChannelMain` is only needed by `openFlagsChannel({ kind: 'utility' })`. The main
 * bundle must not bind it from `electron` at module load (F2): an ESM named import of an
 * export the running `electron` module lacks fails at link time, before any SDK code runs.
 */
describe('main bundle', () => {
  it('does not bind MessageChannelMain from electron at module load (F2)', async () => {
    const options = (rollupConfig as RollupOptions[]).find(
      (entry) => entry.input === 'src/index.ts' && entry.output !== undefined
    )!;
    const bundle = await rollup({ ...options, onwarn: () => undefined });
    const [{ output: esm }, { output: cjs }] = await Promise.all([
      bundle.generate({ format: 'es' }),
      bundle.generate({ format: 'cjs' }),
    ]);
    await bundle.close();
    const esmCode = esm[0].code;
    const cjsCode = cjs[0].code;

    expect(esmCode).toContain('MessageChannelMain');
    expect(esmCode).not.toMatch(/^import\s*\{[^}]*\bMessageChannelMain\b[^}]*\}\s*from\s*['"]electron['"]/m);
    expect(cjsCode).not.toMatch(
      /^(?:var|const|let)\s*(?:\{[^}]*\bMessageChannelMain\b[^}]*\}|MessageChannelMain)\s*=/m
    );
    // The constructor is resolved where the utility channel is opened, not at the top level.
    expect(esmCode).not.toMatch(/^(?:var|const|let)\s+\w+\s*=\s*\w+\.MessageChannelMain\b/m);
  }, 120_000);
});
