import { describe, it, expect, vi } from 'vitest';
import { rollup, type RollupOptions } from 'rollup';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore the rollup config is plain ESM JavaScript
import rollupConfig from '../../rollup.config.mjs';

vi.mock('electron', () => {
  throw new Error('electron must not be imported by the child entry');
});

/**
 * The `./child` entry runs in plain Node children (`ELECTRON_RUN_AS_NODE`), workers and
 * utility processes (§10.2): nothing reachable from it may import `electron`, `dd-trace`,
 * `node:fs` or `src/domain/**`; the evaluator and OpenFeature values are inlined.
 */
describe('child bundle', () => {
  // This case runs a full rollup build of the child entry: a slow or loaded machine (the
  // CI runner, or an emulated container) needs more headroom than the build takes locally.
  it('builds without electron, dd-trace, node:fs or any src/domain module', async () => {
    const options = (rollupConfig as RollupOptions[]).find(
      (entry) => entry.input === 'src/entries/child.ts' && entry.output !== undefined
    );
    expect(options).toBeDefined();
    const bundle = await rollup({ ...options!, onwarn: () => undefined });
    const { output } = await bundle.generate({ format: 'cjs' });
    await bundle.close();
    const chunk = output[0];
    expect(chunk.code).not.toMatch(/require\(['"]electron['"]\)|from ['"]electron['"]/);
    // The inlined evaluator carries a `// Keys for dd-trace-js` source comment: check module
    // references, not the bare word.
    expect(chunk.code).not.toMatch(/require\(['"]dd-trace|from ['"]dd-trace/);
    expect(chunk.code).not.toMatch(/require\(['"](node:)?fs(\/promises)?['"]\)/);
    expect(chunk.code).not.toMatch(/require\(['"]@openfeature\//);
    const modules = Object.keys(chunk.modules).map((id) => id.split('\\').join('/'));
    expect(modules.filter((id) => id.includes('/src/domain/'))).toEqual([]);
    expect(modules.some((id) => id.includes('/src/child/flags/ChildFlagsClient'))).toBe(true);
  }, 180_000);

  it('imports src/entries/child.ts with electron mocked to throw', async () => {
    const child = await import('./child');
    expect(typeof child.connectFlags).toBe('function');
  });
});
