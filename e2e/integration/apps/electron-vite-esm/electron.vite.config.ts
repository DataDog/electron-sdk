import { defineConfig } from 'electron-vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

export default defineConfig({
  main: {
    plugins: [datadogVitePlugin()],
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
