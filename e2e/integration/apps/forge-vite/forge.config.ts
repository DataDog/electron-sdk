import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';

const packageRuntimeDependencies = process.env.DD_ELECTRON_RUNTIME_DEPENDENCY_STRATEGY === 'packager-copy';

const isPackagedApplicationFile = (file: string): boolean => {
  const normalizedFile = file.replaceAll('\\', '/');

  return (
    normalizedFile === '/package.json' ||
    normalizedFile === '/.vite' ||
    normalizedFile.startsWith('/.vite/') ||
    normalizedFile === '/node_modules' ||
    normalizedFile.startsWith('/node_modules/')
  );
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'forge-vite',
    ...(packageRuntimeDependencies && {
      ignore: (file: string) => file !== '' && !isPackagedApplicationFile(file),
    }),
  },
  rebuildConfig: {},
  makers: [],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
