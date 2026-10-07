# Testing

Unit and E2E testing strategy and infrastructure.

## Test Layers

- Unit tests cover every branch and gate the PR adds or changes. E2E tests assert the behavior a customer can observe,
  end to end.
- Don't duplicate e2e coverage with an intermediate integration spec, and don't move unit-level edge cases to e2e.
- Cover third-party behavior that the PR starts relying on (e.g. dd-trace span semantics) with a test, so a dependency
  upgrade can't silently break it.
- Cover every public entry point that the PR's feature touches (e.g. custom context provided through `addError`, not
  only through the context API).

## Writing Tests

- Assert the value the code produces or forwards, not only that a call happened.
- One focused case per behavior: tests of the same behavior that only differ by their inputs are redundant. Keep one
  representative case, or parametrize when each input exercises a distinct branch.
- Keep test doubles simple: mock only what is needed.

## Unit Testing

### Strategy

- Mock network and disk access (fetch API, `node:fs`) to avoid real I/O in tests.
- Mocking direct collaborators to test a component's orchestration is fine.
- Co-locate specs with source files (`src/**/*.spec.ts`).

## E2E Testing

### Strategy

Testing a new feature end-to-end means updating the `e2e/app/` to exercise it, then adding a scenario that asserts on the captured intake events.

- Each test defines the setup it exercises (e.g. its own `beforeSend`) rather than relying on cases hardcoded in the
  e2e app, so its intent reads from the test itself.
- Add scenarios to the existing scenario file of the feature area rather than creating a new file per PR.

### Directory Structure

- **`e2e/app/`**: Minimal Electron app used as test fixture (main, preload, renderer)
- **`e2e/lib/`**: Shared test utilities
  - `mainPage.ts`: Page Object that encapsulates high-level interactions with the main app window.
  - `bridgeWindowPage.ts`: Page Object for bridge windows, with static factory methods to open and await a ready bridge window.
  - `helpers.ts`: Playwright fixtures for app launch/cleanup
  - `intake.ts`: Local HTTP server that captures RUM events sent by the SDK
- **`e2e/scenarios/`**: Test files using Playwright
- **`e2e/integration/`**: Integration tests with realistic Electron setups

### Custom Test Fixtures

Tests import custom `test` and `expect` from `lib/helpers.ts` (not directly from `@playwright/test`) for automatic app lifecycle management.

### Intake Server

The intake server (`e2e/lib/intake.ts`) runs on a dynamic port (OS-assigned) to avoid conflicts. It is managed as a Playwright fixture for automatic startup/teardown.

Integration scenarios inherit a 60-second test timeout from `e2e/playwright.config.ts`. Their
`flushUntilEventArrives` helper defaults to 30 seconds for event delivery, leaving room for app startup and other steps.
The minimal E2E project keeps its 30-second timeout; the session-renewal scenario allows 60 seconds overall
and 30 seconds for renewed-session telemetry. Other intake waits retain their existing limits.

At teardown, the intake fails the test if any captured payload (every endpoint, with replay and profile parts decoded)
contains the app path of an app launched during the test (and its realpath, read at launch), in raw, `/`-separated or
decoded URL form.

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

## Compatibility matrix

Use `yarn test:compatibility:init <target>` and `yarn test:compatibility <target>` to run the same
E2E and integration suites across Electron versions on Linux, macOS, and Windows. See the
[compatibility guide](../e2e/compatibility/README.md) for CI and local commands.
