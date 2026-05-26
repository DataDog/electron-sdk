import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { datadogEsbuildPlugin } from '@datadog/electron-sdk/esbuild-plugin';

const nodeExternals = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });

// Main process (ESM — exercises the SDK plugin's ESM banner path)
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/main.mjs',
  external: nodeExternals,
  plugins: [datadogEsbuildPlugin()],
});

// Preload (CJS — Electron preload scripts must be CJS regardless of main's format)
await build({
  entryPoints: ['src/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/preload.cjs',
  external: nodeExternals,
  plugins: [datadogEsbuildPlugin()],
});

// Renderer (ESM — loaded via <script type="module">)
await build({
  entryPoints: ['src/renderer/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: 'dist/renderer/index.js',
});

await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
