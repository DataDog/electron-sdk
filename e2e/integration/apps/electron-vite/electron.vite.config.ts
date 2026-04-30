import { defineConfig } from 'electron-vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

export default defineConfig({
  main: {
    plugins: [datadogVitePlugin()],
  },
  preload: {},
  renderer: {},
});
