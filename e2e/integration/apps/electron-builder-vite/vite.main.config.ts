import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

export default defineConfig(({ mode }) => {
  const workflow = getWorkflow(mode);

  return {
    plugins: [
      workflow === 'default-copy' ? datadogVitePlugin() : datadogVitePlugin({ copyRuntimeDependencies: false }),
    ],
    build: {
      outDir: `dist/${workflow}`,
      emptyOutDir: false,
      lib: {
        entry: 'src/main.ts',
        formats: ['cjs'],
        fileName: () => 'main.js',
      },
      rollupOptions: {
        external: ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      },
    },
  };
});

function getWorkflow(mode: string): 'default-copy' | 'packager-copy' {
  if (mode === 'default-copy' || mode === 'packager-copy') return mode;
  throw new Error(`Expected Vite mode "default-copy" or "packager-copy", received "${mode}"`);
}
