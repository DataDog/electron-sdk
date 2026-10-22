import { describe, it, expect } from 'vitest';
import { rollup, type RollupOptions } from 'rollup';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore the rollup config is plain ESM JavaScript
import rollupConfig from '../../rollup.config.mjs';

/**
 * The instrument bundle must reach `electron` only through the guarded
 * `_require('electron')` in the entry, after the tracing prelude. A static value import
 * of `electron` in its module graph (e.g. `import { ipcMain } from 'electron'`) makes
 * Rollup hoist a `var electron = require('electron')` binding above the prelude (B1).
 */
describe('instrument bundle', () => {
  it('binds electron only through the guarded require that runs after the prelude', async () => {
    const options = (rollupConfig as RollupOptions[]).find(
      (entry) => entry.input === 'src/entries/instrument.ts' && entry.output !== undefined
    )!;
    const bundle = await rollup({ ...options, onwarn: () => undefined });
    const { output } = await bundle.generate({ format: 'cjs' });
    await bundle.close();
    const code = output[0].code;

    const preludeIndex = code.indexOf('DD_TRACE_DISABLED_INSTRUMENTATIONS');
    const guardedRequireIndex = code.indexOf("_require('electron')");
    expect(preludeIndex).toBeGreaterThan(-1);
    expect(guardedRequireIndex).toBeGreaterThan(preludeIndex);
    expect(code).not.toMatch(/^(?:var|const|let)\s+\w+\s*=\s*require\(['"]electron['"]\)/m);
  }, 60_000);
});
