# Integration Testing

## Strategy

Integration tests validate the SDK in **realistic customer Electron app setups** — different build tools, module formats, and dev vs packaged environments. They complement the E2E tests (which use a minimal fixture app) by catching issues that only surface in specific toolchains.

## Directory Structure

- **`e2e/integration/apps/`**: Realistic Electron apps, one per supported customer toolchain
- **`e2e/integration/lib/integrationFixture.ts`**: Playwright fixture for building, launching, and tearing down each app
- **`e2e/integration/scenarios/integration.scenario.ts`**: Scenarios run against every app × mode combination,
  including configured variants
- **`e2e/integration/scenarios/*`**: Platform-specific scenarios that skip unsupported operating systems and select
  only the relevant app, mode, and variant

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
```

The every-PR integration suite runs only each template's `default` variant. Compatibility runs add the configured
variant projects, such as `electron-builder-vite-packager-copy-packaged`.

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
This loads the SDK's instrumentation, which initializes dd-trace and injects the SDK's preload script into every renderer process via `patchBrowserWindow`.
Vite-based apps use `datadogVitePlugin`, webpack-based apps use `DatadogWebpackPlugin`, and esbuild-based apps use `datadogEsbuildPlugin` to ensure correct module loading order and preload availability in packaged builds.
The `forge-esbuild-esm` app additionally exercises the plugin's ESM path, where the banner loads `instrument` via `createRequire` because ES modules have no global `require`.
Compatibility generation creates isolated `default` and `packager-copy` copies of every integration app. The former
uses the SDK bundler plugin's runtime dependency copy; the latter sets `copyRuntimeDependencies: false` and lets the
app's packager stage production dependencies. Electron Forge's Webpack and Vite plugins normally package only their
bundle directories, so those fixtures supply a packager ignore rule that also admits production `node_modules` in
the `packager-copy` variant.

### Platform-specific scenarios

The compatibility matrix already executes every Playwright project on each configured operating system. Restrict a
platform regression at the scenario level so it is discovered everywhere but only runs on its target OS:

```ts
test.describe('Windows regression @integration @windows', () => {
  test.skip(process.platform !== 'win32', 'Windows-only behavior');

  test('reproduces the affected workflow', async ({ app, mode, variant }) => {
    test.skip(app !== 'electron-builder-vite' || mode !== 'packaged' || variant !== 'packager-copy');
    // Windows-specific assertions
  });
});
```

`windows-payload-extraction.scenario.ts` guards the failure reported in PR #182. It verifies that the
`copyRuntimeDependencies: false` Vite output has no loose `node_modules`, then uses Windows PowerShell 5.1 to archive
and expand the unsigned payload beneath a long temporary path. This exercises the legacy `MAX_PATH` failure boundary
without requiring signing credentials.

## Key design points

### package.json fields

Each app declares several integration properties to ease the instrumentation by the tests:

- `integration.devMain`: compiled main script path for dev-mode launch
- `integration.packagedBinary`: per-platform packaged binary paths

Each app declares a `package` script.

Compatibility variants do not add fields to an app's package manifest. The compatibility generator copies the base
template into one directory per variant and builds each directory with its merged parameter environment.

### SDK Tarball Install

Integration apps install the SDK from a packed tarball (`e2e/integration/integration-sdk.tgz`) generated by `yarn pack`. This mirrors what customers install from npm and validates the `files` field in `package.json`.

Do **not** use `portal:` or `file:` directory references; only the tarball reflects what is actually published.
