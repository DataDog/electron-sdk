# Electron Forge Setup

`copyRuntimeDependencies` defaults to `false` for every Datadog bundler plugin. Keep that default and
configure Forge to stage the SDK as a normal production dependency.

First, keep `@datadog/electron-sdk` in the application's production `dependencies`:

```json
{
  "dependencies": {
    "@datadog/electron-sdk": "<version>"
  }
}
```

The required Forge configuration depends on its bundler plugin.

## Forge Vite

Add an `ignore` function to `packagerConfig` in `forge.config.ts`. It must retain both `.vite` and
root `node_modules`:

```ts
import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
  packagerConfig: {
    // Keep any existing packager options here.
    ignore: (file) => {
      if (!file) return false;
      return !/^[/\\](?:\.vite|node_modules)(?:[/\\]|$)/.test(file);
    },
  },
  // Keep the existing makers and VitePlugin configuration.
};

export default config;
```

Use the Datadog Vite plugin without enabling its copy fallback in the main-process Vite config:

```ts
import { defineConfig } from 'vite';
import { datadogVitePlugin } from '@datadog/electron-sdk/vite-plugin';

export default defineConfig({
  plugins: [datadogVitePlugin()],
});
```

## Forge Webpack

Add an `ignore` function to `packagerConfig` in `forge.config.ts`. It must retain both `.webpack` and
root `node_modules`:

```ts
import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
  packagerConfig: {
    // Keep any existing packager options here.
    ignore: (file) => {
      if (!file) return false;
      return !/^[/\\](?:\.webpack|node_modules)(?:[/\\]|$)/.test(file);
    },
  },
  // Keep the existing makers and WebpackPlugin configuration.
};

export default config;
```

Use the Datadog Webpack plugin without enabling its copy fallback in the main-process Webpack
config:

```ts
import { DatadogWebpackPlugin } from '@datadog/electron-sdk/webpack-plugin';

export const mainConfig = {
  plugins: [new DatadogWebpackPlugin()],
};
```

## Why the Forge override is required

Forge's Vite and Webpack plugins normally set `packagerConfig.ignore` to retain only `.vite` or
`.webpack`. Because the Datadog plugin externalizes the SDK and `dd-trace`, those packages are not
part of the bundle. The override also retains `node_modules`, allowing Electron Packager to prune it
to the production dependency tree and include that tree in the application.

This default allowlist behavior is implemented by Forge's
[Vite plugin](https://github.com/electron/forge/blob/main/packages/plugin/vite/src/VitePlugin.ts) and
[Webpack plugin](https://github.com/electron/forge/blob/main/packages/plugin/webpack/src/WebpackPlugin.ts).

Use a package-manager installation layout supported by Forge. In particular, pnpm must use a
hoisted `node_modules`, and modern Yarn must use the `node-modules` linker. See Forge's
[package-manager requirements](https://www.electronforge.io/cli#usage).

## Other packagers

Keep `copyRuntimeDependencies` disabled and configure the packager to stage production dependencies.
electron-builder and plain Electron Forge already do this by default when packaging the application
source.
