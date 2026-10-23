import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'forge-esbuild-esm',
  },
  rebuildConfig: {},
  makers: [],
  plugins: [],
};

export default config;
