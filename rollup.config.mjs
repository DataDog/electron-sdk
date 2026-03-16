import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import dts from 'rollup-plugin-dts';
import pkg from './package.json' with { type: 'json' };

const sharedPlugins = [
  replace({ preventAssignment: true, __SDK_VERSION__: JSON.stringify(pkg.version) }),
  nodeResolve(),
  commonjs(),
  typescript({
    tsconfig: './tsconfig.build.json',
    declaration: false,
    declarationMap: false,
  }),
];

const config = [
  // Main process: ESM and CJS builds
  {
    input: 'src/index.ts',
    output: [
      {
        dir: 'dist',
        format: 'cjs',
        sourcemap: true,
        entryFileNames: 'index.cjs',
        chunkFileNames: '[name]-[hash].cjs',
      },
      {
        dir: 'dist',
        format: 'esm',
        sourcemap: true,
        entryFileNames: 'index.mjs',
        chunkFileNames: '[name]-[hash].mjs',
      },
    ],
    external: ['electron'],
    plugins: sharedPlugins,
  },
  // Auto-instrument preload: self-contained CJS script injected via session.registerPreloadScript()
  {
    input: 'src/entries/preload.ts',
    output: [
      {
        file: 'dist/preload-auto.cjs',
        format: 'cjs',
        sourcemap: true,
      },
    ],
    external: ['electron'],
    plugins: sharedPlugins,
  },
  // TypeScript declarations: main
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.d.ts',
      format: 'esm',
    },
    plugins: [dts({ tsconfig: './tsconfig.build.json' })],
  },
];

export default config;
