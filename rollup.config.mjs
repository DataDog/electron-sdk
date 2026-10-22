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
        manualChunks: (id) => (id.replaceAll('\\', '/').includes('/wasm/') ? 'wasm' : undefined),
      },
      {
        dir: 'dist',
        format: 'esm',
        sourcemap: true,
        entryFileNames: 'index.mjs',
        chunkFileNames: '[name].chunk.mjs',
        manualChunks: (id) => (id.replaceAll('\\', '/').includes('/wasm/') ? 'wasm' : undefined),
      },
    ],
    external: ['electron'],
    plugins: sharedPlugins,
  },
  // Instrumentation: imported before electron to patch BrowserWindow, IPC, and net APIs
  {
    input: 'src/entries/instrument.ts',
    output: [
      {
        file: 'dist/instrument.cjs',
        format: 'cjs',
        sourcemap: true,
      },
      {
        file: 'dist/instrument.mjs',
        format: 'esm',
        sourcemap: true,
      },
    ],
    external: ['electron', 'dd-trace'],
    plugins: sharedPlugins,
  },
  // Vite plugin: ensures Electron instrumentation runs before hoisted requires
  {
    input: 'src/entries/vite-plugin.ts',
    output: [
      {
        file: 'dist/vite-plugin.cjs',
        format: 'cjs',
        sourcemap: true,
      },
      {
        file: 'dist/vite-plugin.mjs',
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
  // TypeScript declarations: instrument
  {
    input: 'src/entries/instrument.ts',
    output: {
      file: 'dist/instrument.d.ts',
      format: 'esm',
    },
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
  },
  // TypeScript declarations: vite-plugin
  {
    input: 'src/entries/vite-plugin.ts',
    output: {
      file: 'dist/vite-plugin.d.ts',
      format: 'esm',
    },
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
  },
  // Webpack plugin: copies dd-trace preload into webpack output
  {
    input: 'src/entries/webpack-plugin.ts',
    output: [
      {
        file: 'dist/webpack-plugin.cjs',
        format: 'cjs',
        sourcemap: true,
      },
      {
        file: 'dist/webpack-plugin.mjs',
        format: 'esm',
        sourcemap: true,
      },
    ],
    external: ['electron'],
    plugins: sharedPlugins,
  },
  // TypeScript declarations: webpack-plugin
  {
    input: 'src/entries/webpack-plugin.ts',
    output: {
      file: 'dist/webpack-plugin.d.ts',
      format: 'esm',
    },
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
  },
  // esbuild plugin: injects the Electron instrumentation banner and externalizes dependencies
  {
    input: 'src/entries/esbuild-plugin.ts',
    output: [
      {
        file: 'dist/esbuild-plugin.cjs',
        format: 'cjs',
        sourcemap: true,
      },
      {
        file: 'dist/esbuild-plugin.mjs',
        format: 'esm',
        sourcemap: true,
      },
    ],
    external: ['electron'],
    plugins: sharedPlugins,
  },
  // TypeScript declarations: esbuild-plugin
  {
    input: 'src/entries/esbuild-plugin.ts',
    output: {
      file: 'dist/esbuild-plugin.d.ts',
      format: 'esm',
    },
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
  },
  // Preload script: renderer bridge, output as plain CJS for BrowserWindow injection
  {
    input: 'src/entries/preload.ts',
    output: {
      file: 'dist/preload.js',
      format: 'cjs',
    },
    external: ['electron'],
    plugins: sharedPlugins,
  },
  // Renderer entry: feature flags provider for renderer pages (M4/G2)
  // @openfeature/web-sdk and @openfeature/core are external optional peers so the
  // customer's renderer bundler resolves their single copy.
  {
    input: 'src/entries/renderer.ts',
    output: [
      { file: 'dist/renderer.cjs', format: 'cjs', sourcemap: true },
      { file: 'dist/renderer.mjs', format: 'es', sourcemap: true },
    ],
    external: ['@openfeature/web-sdk', '@openfeature/core'],
    plugins: sharedPlugins,
  },
  {
    input: 'src/entries/renderer.ts',
    output: {
      file: 'dist/renderer.d.ts',
      format: 'esm',
    },
    external: ['@openfeature/web-sdk', '@openfeature/core'],
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
  },
  // Child entry: feature flags in spawned processes (M6/G4). Runs in plain Node children,
  // workers and utility processes: no electron, and OpenFeature values are inlined like main.
  {
    input: 'src/entries/child.ts',
    output: [
      { file: 'dist/child.cjs', format: 'cjs', sourcemap: true },
      { file: 'dist/child.mjs', format: 'es', sourcemap: true },
    ],
    plugins: sharedPlugins,
  },
  {
    input: 'src/entries/child.ts',
    output: {
      file: 'dist/child.d.ts',
      format: 'esm',
    },
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
  },
];

export default config;
