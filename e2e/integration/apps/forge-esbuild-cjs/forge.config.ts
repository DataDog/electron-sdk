import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'forge-esbuild-cjs',
  },
  rebuildConfig: {},
  makers: [],
  plugins: [],
};

export default config;
