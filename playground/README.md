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

## Development with SDK Changes

From the root directory, run:

```bash
yarn dev:playground
```

This will:

- Watch and rebuild the parent SDK on changes
- Automatically reload the playground when SDK is updated
- Run both processes concurrently with color-coded output
