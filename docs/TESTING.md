# Testing

Unit and E2E testing strategy and infrastructure.

## Unit Testing

### Strategy

- Mock network and disk access (fetch API, `node:fs`) to avoid real I/O in tests.
- Transitive dependency mocks are acceptable to only test orchestration. Consider integration / e2e test to exercise real code path.
- Co-locate specs with source files (`src/**/*.spec.ts`).

## E2E Testing

### Strategy

Testing a new feature end-to-end means updating the `e2e/app/` to exercise it, then adding a scenario that asserts on the captured intake events.

### Directory Structure

- **`e2e/app/`**: Minimal Electron app used as test fixture (main, preload, renderer)
- **`e2e/lib/`**: Shared test utilities
  - `mainPage.ts`: Page Object that encapsulates high-level interactions with the main app window.
  - `bridgeWindowPage.ts`: Page Object for bridge windows, with static factory methods to open and await a ready bridge window.
  - `helpers.ts`: Playwright fixtures for app launch/cleanup
  - `intake.ts`: Local HTTP server that captures RUM events sent by the SDK
- **`e2e/scenarios/`**: Test files using Playwright
- **`e2e/integration/`**: Integration tests with realistic Electron setups
- **`e2e/compatibility/`**: Scheduled Electron-version and operating-system matrix

### Custom Test Fixtures

Tests import custom `test` and `expect` from `lib/helpers.ts` (not directly from `@playwright/test`) for automatic app lifecycle management.

### Intake Server

The intake server (`e2e/lib/intake.ts`) runs on a dynamic port (OS-assigned) to avoid conflicts. It is managed as a Playwright fixture for automatic startup/teardown.

Session-renewal telemetry and integration startup-view checks allow up to 30 seconds for events to arrive, with a
60-second test timeout to leave room for app startup and other steps. Other event waits retain their existing limits.

#### `rumBrowserSdk` option

By default, no browser-sdk runs in the main window renderer. Tests that need real user-activity tracking (e.g. session renewal via click) opt in per-describe or per file:

```ts
test.describe('session renewal', () => {
  test.use({ rumBrowserSdk: {} });
  // ...
});
```

`mainPage.renewSession()` stops the current session, triggers a renderer click, and waits up to 10 seconds for the
main-process SDK to report a new active session ID. This ensures subsequent telemetry is generated after the
per-session deduplication state resets, instead of relying on a fixed IPC delay.

Pass an object to override specific init options (merged with the defaults). The fixture serialises the config into `DD_RUM_BROWSER_SDK` and the preload exposes it as `window.e2eConfig.rumBrowserSdk`.

### E2E App as Reference

The `e2e/app/` is the reference implementation for IPC bridge patterns and SDK integration.

### Integration testing

See e2e/integration/README.md for integration tests strategy and structure

### Compatibility testing

The every-PR jobs continue to run the repository's current Electron version. Scheduled compatibility pipelines run
the same minimal E2E scenarios and every configured integration app/variant against each explicitly pinned Electron
target on Linux, macOS, and Windows. See e2e/compatibility/README.md for configuration and local usage.
The pipeline ref selects the compatibility harness; `DD_ELECTRON_SDK_GIT_REF` can independently select a committed
SDK branch, tag, or SHA. Target/template overlays capture version-specific fixture differences without duplicating a
complete application.
