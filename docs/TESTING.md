# Testing

Unit and E2E testing strategy and infrastructure.

## Unit Testing

### Strategy

- Mock the fetch API, not internal packages. Avoid real HTTP calls in tests.
- Co-locate specs with source files (`src/**/*.spec.ts`).

## E2E Testing

### Strategy

Testing a new feature end-to-end means updating the `e2e/app/` to exercise it, then adding a scenario that asserts on the captured intake events.

### Directory Structure

- **`e2e/app/`**: Minimal Electron app used as test fixture (main, preload, renderer)
- **`e2e/lib/`**: Shared test utilities
  - `helpers.ts`: Playwright fixtures for app launch/cleanup
  - `intake.ts`: Local HTTP server that captures RUM events sent by the SDK
- **`e2e/scenarios/`**: Test files using Playwright

### Custom Test Fixtures

Tests import custom `test` and `expect` from `lib/helpers.ts` (not directly from `@playwright/test`) for automatic app lifecycle management.

### Intake Server

The intake server (`e2e/lib/intake.ts`) runs on a dynamic port (OS-assigned) to avoid conflicts. It is managed as a Playwright fixture for automatic startup/teardown.

### E2E App as Reference

The `e2e/app/` is the reference implementation for IPC bridge patterns and SDK integration.
