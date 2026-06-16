# Electron SDK Playground

Developer sandbox for `@datadog/electron-sdk` — experiment with SDK features, prototype scenarios, and validate changes with a mock intake.

## Getting Started

```bash
# From the repo root — builds SDK + playground with hot reload
yarn dev:playground

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
