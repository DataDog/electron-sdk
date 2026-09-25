# Electron compatibility tests

Run the maintained E2E and integration apps against the Electron versions in `config.json`.
This PR supports Linux and macOS. Each run packages the current SDK checkout and prepares isolated
apps under `generated/<target>/`, leaving the source templates and their lockfiles unchanged.

```sh
yarn install --immutable
yarn test:compatibility:init electron-41
yarn test:compatibility electron-41
# On Linux without a display:
xvfb-run -a yarn test:compatibility electron-41
```

Preparation downloads and verifies Electron, installs each app, and packages the integration apps.
Tests check the actual Electron version at launch. Each integration app runs in development and
packaged modes, including a packaged variant where the packager copies runtime dependencies.
The existing `test:e2e` and `test:integration` commands still use their regular fixtures.

Pass normal Playwright options to select tests without preparing another target:

```sh
yarn test:compatibility electron-41 --project=e2e
yarn test:compatibility electron-41 --project=forge-vite-packaged --grep 'view event'
```

## CI

Start a web or scheduled pipeline with `COMPATIBILITY_TESTS=true`. It generates Linux and macOS jobs
for every configured target. Nightly failures are allowed; stable and prerelease failures fail the pipeline.
The regular pipeline runs when `COMPATIBILITY_TESTS` is false.

Optional comma-separated filters limit the matrix:

- `DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS=linux,macos`
- `DD_ELECTRON_COMPATIBILITY_TARGETS=electron-41`

Generate the child pipeline locally with `yarn test:compatibility:ci:generate`.
Linux uses the existing CI image with Xvfb. macOS uses the Sequoia ARM64 runner and a job-local npm
cache to avoid permissions on the runner's shared cache. Logs, Playwright results and target metadata
are uploaded even on failure. Shell pipelines use `pipefail` so logging cannot hide a failed command.
