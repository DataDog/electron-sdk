# Integration Testing

## Strategy

Integration tests validate the SDK in **realistic customer Electron app setups** — different build tools, module formats, and dev vs packaged environments. They complement the E2E tests (which use a minimal fixture app) by catching issues that only surface in specific toolchains.

## Directory Structure

- **`e2e/integration/apps/`**: Realistic Electron apps, one per supported customer toolchain
- **`e2e/integration/lib/integrationFixture.ts`**: Playwright fixture for building, launching, and tearing down each app
- **`e2e/integration/scenarios/integration.scenario.ts`**: Scenarios run against every app × mode combination,
  including configured variants

## Usage

```bash
yarn test:integration:init     # install and package all integration apps
yarn test:integration          # launch all integration tests
```

## Playwright Projects

Each app is tested in two modes (`dev` and `packaged`), defined as generated Playwright projects in `e2e/playwright.config.ts`.
For example with `forge-webpack` app:

```
forge-webpack-dev              # unpackaged, webpack output
forge-webpack-packaged         # electron-forge package output
```

Run a specific combination locally:

```bash
yarn test:integration --project=forge-webpack-dev
yarn test:integration --project=forge-webpack-packaged
yarn test:integration --project=electron-builder-vite-packaged
yarn test:integration --project=electron-builder-vite-plugin-copy-packaged
yarn test:integration --project=forge-webpack-bundled-dev
yarn test:integration --project=electron-vite-esm-bundled-packaged
```

## Supported Toolchains

| App                     | Bundler             | Main format | Packager         |
| ----------------------- | ------------------- | ----------- | ---------------- |
| `forge-webpack`         | Webpack (via Forge) | CJS         | Electron Forge   |
| `forge-vite`            | Vite (via Forge)    | CJS         | Electron Forge   |
| `forge-esbuild-cjs`     | esbuild             | CJS         | Electron Forge   |
| `forge-esbuild-esm`     | esbuild             | ESM         | Electron Forge   |
| `electron-vite`         | electron-vite CLI   | CJS         | electron-builder |
| `electron-builder-vite` | Vite (manual)       | CJS         | electron-builder |

All apps use `import '@datadog/electron-sdk/instrument'` before importing `electron` in their main process.
This loads the SDK's instrumentation and injects the SDK's preload script into every renderer process via `patchBrowserWindow`. The regular SDK `init()` initializes dd-trace-electron afterward.
Vite-based apps use `datadogVitePlugin`, webpack-based apps use `DatadogWebpackPlugin`, and esbuild-based apps use `datadogEsbuildPlugin` to ensure correct module loading order and preload availability in packaged builds.
The `forge-esbuild-esm` app additionally exercises the plugin's ESM path, where the banner loads `instrument` via `createRequire` because ES modules have no global `require`.
The Forge Vite and Webpack apps override `packagerConfig.ignore` so Forge packages both the bundler
output and root `node_modules`; Electron Packager then stages the production dependency tree.
Every app is built in three independent configurations from `variants.json`:

| Variant       | Plugin options                   | SDK dependency        |
| ------------- | -------------------------------- | --------------------- |
| Default       | `copyRuntimeDependencies: false` | Production dependency |
| `plugin-copy` | `copyRuntimeDependencies: true`  | Production dependency |
| `bundled`     | `bundledMode: true`              | Production dependency |

Each configuration runs in development and packaged modes. Bundled builds do not pass
`copyRuntimeDependencies`, since the option is irrelevant in that mode. Environment selection uses
`DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES` and `DD_ELECTRON_BUNDLED_MODE`; electron-vite's automatic
externalization exclusion is applied only in the bundled variant.

The default build stays in the maintained app directory. Other variants are materialized under
`e2e/integration/generated/<app>-<variant>/`, with independent dependencies and output directories.
The same configuration list drives compatibility preparation and Playwright project generation.
All maintained manifests keep the SDK in `dependencies`. The standalone-output scenario proves
bundled output can initialize and deliver events without an installed SDK or tracer, without changing
the baseline dependency declarations. Runtime tests check the loaded modules and emitted preload;
packaging tests check assets and dependency placement in every packaged variant.

The Windows payload extraction scenario covers the regression described in
[#182](https://github.com/DataDog/electron-sdk/pull/182). It verifies that plugin copying includes the embedded tracer without its former deep package tree,
while the copy-disabled Vite output extracts completely with Windows
PowerShell 5.1. The separate packaging scenario checks dependency placement in `app.asar`; this does not
run a full MSIX build or signing pipeline.

## Key design points

### package.json fields

Each app declares several integration properties to ease the instrumentation by the tests:

- `integration.devMain`: compiled main script path for dev-mode launch
- `integration.packagedBinary`: per-platform packaged binary paths

Each app declares a `package` script.

### SDK Tarball Install

Integration apps install the SDK from a packed tarball (`e2e/integration/integration-sdk.tgz`) generated by `yarn pack`. This mirrors what customers install from npm and validates the `files` field in `package.json`.

Do **not** use `portal:` or `file:` directory references; only the tarball reflects what is actually published.
