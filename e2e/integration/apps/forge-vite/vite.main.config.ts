import { defineConfig } from 'vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

const copyRuntimeDependencies = process.env.DD_ELECTRON_RUNTIME_DEPENDENCY_STRATEGY !== 'packager-copy';

export default defineConfig({
  plugins: [datadogVitePlugin({ copyRuntimeDependencies })],
});
