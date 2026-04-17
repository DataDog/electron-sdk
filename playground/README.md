# Electron SDK Playground

A simple Electron application to test and demonstrate the `@datadog/electron-sdk`.

## Features

- TypeScript-based Electron application
- Hot reload during development with `electron-reloader`
- SDK initialized in main process via IPC
- Secure context isolation with IPC communication
- Button to trigger SDK initialization

## Getting Started

### Install Dependencies

```bash
cd playground
yarn
```

### Build the TypeScript Files

```bash
yarn build
```

### Run the Playground

```bash
yarn start
```

### Development Mode (with hot reload)

For development with automatic reload on file changes:

```bash
yarn dev
```

This will:

- Watch TypeScript files for changes and recompile automatically
- Reload Electron when files change
- Open DevTools by default

## Testing

Automated Playwright tests validate playground scenarios against a mock intake server.

### Run Tests

```bash
# From playground/
yarn test

# Or from root
yarn playground:test
```

### Creating a Scenario

1. **Add a button + IPC handler** in `src/main.ts` and `src/preload.ts` for the feature you want to test
2. **Write a test** in `test/<name>.scenario.ts`:

```typescript
import { test, expect } from './helpers';

test('description', async ({ window, intake }) => {
  // Click a button in the playground
  await window.click('#my-button');

  // Assert events arrived at the mock intake
  const events = await intake.getEventsByType('resource', 10_000);
  expect(events.length).toBeGreaterThanOrEqual(1);
});
```

3. **Run** `yarn test` and iterate

The test harness auto-launches the playground app with SDK events routed to a mock intake server via the `DD_SDK_PROXY` env var.

## Development with SDK Changes

From the root directory, run:

```bash
yarn dev:playground
```

This will:

- Watch and rebuild the parent SDK on changes
- Automatically reload the playground when SDK is updated
- Run both processes concurrently with color-coded output
