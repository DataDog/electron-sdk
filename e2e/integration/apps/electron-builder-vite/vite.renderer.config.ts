import { defineConfig } from 'vite';
import { getWorkflow } from './workflow';

export default defineConfig(({ mode }) => ({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: `../../dist/${getWorkflow(mode)}/renderer`,
    emptyOutDir: true,
  },
}));
