import { defineConfig } from 'electron-vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

const copyRuntimeDependencies = process.env.DD_ELECTRON_RUNTIME_DEPENDENCY_STRATEGY !== 'packager-copy';

export default defineConfig({
  main: {
    plugins: [datadogVitePlugin({ copyRuntimeDependencies })],
    build: {
      rollupOptions: {
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
        },
      },
    },
  },
  preload: {},
  renderer: {},
});
