import { defineConfig } from 'electron-vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

const bundledMode = process.env.DD_ELECTRON_BUNDLED_MODE === 'true';
const copyRuntimeDependencies = process.env.DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES === 'true';

export default defineConfig({
  main: {
    plugins: [datadogVitePlugin(bundledMode ? { bundledMode: true } : { copyRuntimeDependencies })],
    ...(bundledMode && { build: { externalizeDeps: { exclude: ['@datadog/electron-sdk', 'dd-trace-electron'] } } }),
  },
  preload: {},
  renderer: {},
});
