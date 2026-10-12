# Electron SDK Playground

Developer sandbox for `@datadog/electron-sdk` — experiment with SDK features, prototype scenarios, and validate changes with a mock intake.

## Getting Started

```bash
# From the repo root — builds SDK + playground with hot reload
yarn dev

# Or standalone (playground only, requires SDK already built)
cd playground && yarn dev
```

## Testing

The playground includes a Playwright test infrastructure for prototyping and self-validation. Scenarios launch the app in headless mode with a mock intake, so agents and developers can iterate and verify that events flow end-to-end.

```bash
cd playground && yarn test
```

### Writing scenarios

Test files live in `test/` and must match `*.scenario.ts`. They use Playwright's Electron support with fixtures from `test/helpers.ts`:

- **`intake`** — mock HTTP server capturing RUM events (reuses `e2e/lib/intake.ts`)
- **`electronApp`** — headless Electron app with `DD_TEST_MODE` and `DD_SDK_PROXY` env vars
- **`window`** — first browser window, ready after load

### Local prototyping

`test/local/` is gitignored — use it for throwaway scenarios without affecting CI.

## Source maps

The main process reports under the `playground-main` service, renderers under `playground-renderer`. The version is
resolved at build time (`PLAYGROUND_VERSION` if set, otherwise the current git SHA, or `dev` when git is unavailable)
and recorded in `dist/version.json`, so running the app never needs the variable.

`PLAYGROUND_ENV=staging|prod` (default `staging`) selects the Datadog org, both for the app and for the upload.

The renderer can be served over three protocols, to check source map resolution for each:

```bash
RENDERER_PROTOCOL=app yarn start    # default, app://app/
RENDERER_PROTOCOL=file yarn start   # file://
RENDERER_PROTOCOL=http yarn start   # http://127.0.0.1:8765 (RENDERER_HTTP_PORT to change)
```

To upload source maps manually, use a fresh version for each iteration and an API key from the selected org:

```bash
PLAYGROUND_VERSION=0.1.3 DATADOG_API_KEY=<key> yarn upload-sourcemaps   # builds, then uploads; --dry-run to check
yarn electron .   # runs the build that was just uploaded (pass the same PLAYGROUND_ENV as the upload)
```

`yarn start` rebuilds first, so it resolves the version again (git SHA without `PLAYGROUND_VERSION`).

## Architecture

### Module System Split

The playground uses different module systems due to Electron constraints:

- **main.ts, preload.ts**: CommonJS (`tsconfig.json`) — Electron requires this
- **renderer.ts**: ES modules (`tsconfig.renderer.json`) — runs in browser context

**Critical detail:** Using `export {}` in CommonJS code generates `exports` references that fail in browser. Separate compilation configs prevent this.

### Hot Reload System

Two watchers handle different reload scenarios:

1. **electron-reloader** (3s startup delay) — watches playground files, reloads windows
2. **chokidar** (5s grace period, 200ms debounce) — watches parent SDK's dist/, clears require cache, relaunches app

Grace periods prevent reload loops during initial TypeScript compilation.
