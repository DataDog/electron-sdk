# Runtime Dependencies

`copyRuntimeDependencies` defaults to `false` for every Datadog bundler plugin. The plugins still
externalize the SDK and `dd-trace` and inject instrumentation, but do not copy runtime dependencies
into the build output. The application packager must include those dependencies in the packaged app;
disabling plugin copying does not configure the packager automatically.

| Application setup               | Required configuration                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Forge with its Vite plugin      | Retain `.vite` and root `node_modules` using the override below.                 |
| Forge with its Webpack plugin   | Retain `.webpack` and root `node_modules` using the override below.              |
| electron-builder or plain Forge | Preserve the packager's default production dependency staging.                   |
| Custom packaging                | Include the SDK, `dd-trace`, and their runtime dependencies in the packaged app. |

Applications already using `copyRuntimeDependencies: false` with working packager staging need no
configuration change.

First, keep `@datadog/electron-sdk` in the application's production `dependencies`:

```json
{
  "dependencies": {
    "@datadog/electron-sdk": "<version>"
  }
}
```

The SDK declares `dd-trace` as a runtime dependency, so installing it separately is not required for
SDK use.

For Forge Vite and Webpack, merge the following overrides into the existing `packagerConfig`.
Extend the allowlist if the application needs additional root assets at runtime.

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

The packager cannot determine which production dependencies are already bundled. To reduce duplicate
files, keep packages needed at runtime in `dependencies` and move packages that are fully bundled
into `devDependencies`. Installed optional dependencies may also be retained by the packager.

Forge's default allowlist behavior is implemented by its
[Vite plugin](https://github.com/electron/forge/blob/main/packages/plugin/vite/src/VitePlugin.ts) and
[Webpack plugin](https://github.com/electron/forge/blob/main/packages/plugin/webpack/src/WebpackPlugin.ts).

Use a package-manager installation layout supported by Forge. In particular, pnpm must use a
hoisted `node_modules`, and modern Yarn must use the `node-modules` linker. See Forge's
[package-manager requirements](https://www.electronforge.io/cli#usage).

## Other packagers

Keep `copyRuntimeDependencies` disabled and configure the packager to stage production dependencies.
electron-builder and plain Electron Forge already do this by default when packaging the application
source. The main-process bundler configuration must still register the corresponding
[`datadogVitePlugin()`](../src/entries/vite-plugin.ts) or
[`DatadogWebpackPlugin`](../src/entries/webpack-plugin.ts); see the
[bundler plugin examples](../README.md#bundler-plugins).

## Compatibility fallback

If the packager cannot stage runtime dependencies, enable the plugin's best-effort copier in the
existing main-process bundler configuration:

```ts
datadogVitePlugin({ copyRuntimeDependencies: true });
new DatadogWebpackPlugin({ copyRuntimeDependencies: true });
datadogEsbuildPlugin({ copyRuntimeDependencies: true });
```

Use the plugin matching the application's bundler. This fallback depends on the package manager's
installation layout; prefer packager staging when available.

## Verify the packaged application

1. Remove previous build and package output before rebuilding, so dependencies copied by an earlier
   build cannot hide missing packager configuration.
2. Inspect the packaged application's `node_modules` (inside `app.asar` if enabled) for the SDK,
   `dd-trace`, and their runtime dependencies.
3. Launch the packaged application outside the development checkout and verify SDK event delivery.
   A development launch can resolve the checkout's `node_modules` and does not verify packaging.
