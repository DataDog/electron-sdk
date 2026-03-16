# Datadog SDK for Electron

Real User Monitoring for Electron applications.

> **Alpha (v0.1.0)** — This SDK is in early development. APIs may change between releases.

## Getting Started

### Prerequisites

- Node.js 25+
- Electron 39+

### Install

```bash
yarn add @datadog/electron-sdk
# or
npm install @datadog/electron-sdk
```

### Initialize

Call `init` in your **main process** before creating any browser windows:

```ts
import { init } from '@datadog/electron-sdk';

await init({
  clientToken: '<CLIENT_TOKEN>',
  applicationId: '<APPLICATION_ID>',
  service: 'my-electron-app',
  site: 'datadoghq.com',
});
```

## Available Features

- **Sessions** — Session-based event grouping
- **RUM Views** — One view per main process instance
- **RUM Errors** — Capture Node errors and crashes in main process
- **Renderer Bridge** — Capture RUM events from renderer processes via the browser SDK

### Renderer Process Support

The SDK automatically registers a preload script that exposes a `DatadogEventBridge` to every renderer process. When `@datadog/browser-rum` is initialized in a renderer, it detects the bridge and routes events through IPC to the main process instead of posting directly to the intake.

Both `contextIsolation: true` (default) and `contextIsolation: false` are supported.

> **Note:** Only the automatic preload mode is currently supported. Manual bridge setup is not yet available.

## API

### `init(config: InitConfiguration): Promise<boolean>`

Initialize the SDK. Returns `true` on success, `false` if configuration is invalid.

### `addError(error: unknown, options?: ErrorOptions): void`

Report a manually handled error.

```ts
import { addError } from '@datadog/electron-sdk';

try {
  riskyOperation();
} catch (error) {
  addError(error, { context: { component: 'sync' } });
}
```

### Configuration Options

| Option                | Type                                     | Required | Default  | Description                                                                                                                        |
| --------------------- | ---------------------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `clientToken`         | `string`                                 | Yes      | —        | Datadog client token                                                                                                               |
| `applicationId`       | `string`                                 | Yes      | —        | RUM application ID                                                                                                                 |
| `site`                | `string`                                 | Yes      | —        | Datadog site (e.g. `datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com`, `us5.datadoghq.com`, `ap1.datadoghq.com`, `ddog-gov.com`) |
| `service`             | `string`                                 | Yes      | —        | Service name                                                                                                                       |
| `env`                 | `string`                                 | No       | —        | Application environment                                                                                                            |
| `version`             | `string`                                 | No       | —        | Application version                                                                                                                |
| `telemetrySampleRate` | `number`                                 | No       | `20`     | Telemetry sample rate (0–100)                                                                                                      |
| `batchSize`           | `'SMALL' \| 'MEDIUM' \| 'LARGE'`         | No       | —        | Batch size for event uploads                                                                                                       |
| `uploadFrequency`     | `'RARE' \| 'NORMAL' \| 'FREQUENT'`       | No       | —        | Upload frequency for event batches                                                                                                 |
| `defaultPrivacyLevel` | `'mask' \| 'allow' \| 'mask-user-input'` | No       | `'mask'` | Default privacy level for renderer session replay                                                                                  |
| `allowedWebViewHosts` | `string[]`                               | No       | `[]`     | Hostnames allowed for the renderer bridge                                                                                          |
