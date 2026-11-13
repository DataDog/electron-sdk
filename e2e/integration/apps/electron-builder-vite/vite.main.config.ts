import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

const bundledMode = process.env.DD_ELECTRON_BUNDLED_MODE === 'true';
const copyRuntimeDependencies = process.env.DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES === 'true';

export default defineConfig({
  plugins: [datadogVitePlugin(bundledMode ? { bundledMode: true } : { copyRuntimeDependencies })],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: { entry: 'src/main.ts', formats: ['cjs'], fileName: () => 'main.js' },
    rollupOptions: { external: ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)] },
  },
});
