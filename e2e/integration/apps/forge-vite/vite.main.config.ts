import { defineConfig } from 'vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

const copyRuntimeDependencies = process.env.DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES === 'true';

export default defineConfig({
  plugins: [datadogVitePlugin({ copyRuntimeDependencies })],
});
