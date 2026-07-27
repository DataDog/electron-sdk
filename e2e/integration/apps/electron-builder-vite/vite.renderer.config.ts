import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: `../../dist/${getWorkflow(mode)}/renderer`,
    emptyOutDir: true,
  },
}));

function getWorkflow(mode: string): 'default-copy' | 'packager-copy' {
  if (mode === 'default-copy' || mode === 'packager-copy') return mode;
  throw new Error(`Expected Vite mode "default-copy" or "packager-copy", received "${mode}"`);
}
