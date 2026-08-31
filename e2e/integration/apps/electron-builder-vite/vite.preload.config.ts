import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import { getWorkflow } from './workflow';

export default defineConfig(({ mode }) => ({
  build: {
    outDir: `dist/${getWorkflow(mode)}`,
    emptyOutDir: false,
    lib: {
      entry: 'src/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    },
  },
}));
