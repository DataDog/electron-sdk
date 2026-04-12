import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import replace from '@rollup/plugin-replace';
import dts from 'rollup-plugin-dts';
import pkg from './package.json' with { type: 'json' };

const sharedPlugins = [
  replace({ preventAssignment: true, __SDK_VERSION__: JSON.stringify(pkg.version) }),
  nodeResolve(),
  commonjs(),
  json(),
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
        // Explicit chunk names so each dynamic import gets a meaningful, stable filename
        chunkFileNames: '[name].chunk.cjs',
        manualChunks: (id) => (id.includes('/wasm/') ? 'wasm' : undefined),
      },
      {
        dir: 'dist',
        format: 'esm',
        sourcemap: true,
        entryFileNames: 'index.mjs',
        chunkFileNames: '[name].chunk.mjs',
        manualChunks: (id) => (id.includes('/wasm/') ? 'wasm' : undefined),
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
      {
        file: 'dist/preload.mjs',
        format: 'esm',
        sourcemap: true,
      },
    ],
    external: ['electron'],
    plugins: sharedPlugins,
  },
  // Early init: imported before electron to hook require('electron') for BrowserWindow wrapping
  {
    input: 'src/entries/init.ts',
    output: [
      {
        file: 'dist/init.cjs',
        format: 'cjs',
        sourcemap: true,
      },
      {
        file: 'dist/init.mjs',
        format: 'esm',
        sourcemap: true,
      },
    ],
    external: ['electron'],
    plugins: sharedPlugins,
  },
  // TypeScript declarations: main
  {
    input: 'src/index.ts',
    external: ['electron'],
    output: {
      file: 'dist/index.d.ts',
      format: 'esm',
    },
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
  },
  // TypeScript declarations: preload
  {
    input: 'src/entries/preload.ts',
    output: {
      file: 'dist/preload.d.ts',
      format: 'esm',
    },
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
  },
  // TypeScript declarations: init
  {
    input: 'src/entries/init.ts',
    output: {
      file: 'dist/init.d.ts',
      format: 'esm',
    },
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
  },
];

export default config;
