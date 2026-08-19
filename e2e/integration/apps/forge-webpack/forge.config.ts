import type { ForgeConfig } from '@electron-forge/shared-types';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const packageRuntimeDependencies = process.env.DD_ELECTRON_RUNTIME_DEPENDENCY_STRATEGY === 'packager-copy';

const isPackagedApplicationFile = (file: string): boolean => {
  const normalizedFile = file.replaceAll('\\', '/');

  return (
    normalizedFile === '/package.json' ||
    normalizedFile === '/.webpack' ||
    normalizedFile.startsWith('/.webpack/') ||
    normalizedFile === '/node_modules' ||
    normalizedFile.startsWith('/node_modules/')
  );
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'forge-webpack',
    ...(packageRuntimeDependencies && {
      ignore: (file: string) => file !== '' && !isPackagedApplicationFile(file),
    }),
  },
  rebuildConfig: {},
  makers: [],
  plugins: [
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/index.html',
            js: './src/renderer/index.ts',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
  ],
};

export default config;
