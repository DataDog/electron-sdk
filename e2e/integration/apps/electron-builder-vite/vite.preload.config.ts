import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

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

function getWorkflow(mode: string): 'default-copy' | 'packager-copy' {
  if (mode === 'default-copy' || mode === 'packager-copy') return mode;
  throw new Error(`Expected Vite mode "default-copy" or "packager-copy", received "${mode}"`);
}
