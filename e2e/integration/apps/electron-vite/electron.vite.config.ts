import { defineConfig } from 'electron-vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

const copyRuntimeDependencies = process.env.DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES !== 'false';

export default defineConfig({
  main: {
    plugins: [datadogVitePlugin({ copyRuntimeDependencies })],
  },
  preload: {},
  renderer: {},
});
