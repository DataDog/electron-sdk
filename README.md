# Datadog SDK for Electron

Real User Monitoring for Electron applications.

> **Alpha (v0.X.X)** — This SDK is in early development. APIs may change between releases.

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
- **Operation Monitoring** _(experimental)_ — Track start / succeed / fail steps of critical user-facing workflows

### Renderer Process Support

In order to monitor the renderer process, the [Browser SDK](https://docs.datadoghq.com/real_user_monitoring/application_monitoring/browser/setup/) must be setup in pages loaded by the renderer.
The Electron SDK exposes a `DatadogEventBridge` to every renderer process via a preload script. When present, the Browser SDK detects the bridge and routes events through IPC to the Electron SDK instead of sending them directly to Datadog servers.

#### Unbundled apps

For apps that don't bundle the main process, the SDK automatically registers the preload script. No additional setup is needed.

#### Bundled apps (Vite, Webpack)

If your main process is bundled (e.g. Electron Forge with the Vite or Webpack plugin), automatic preload injection won't work. Instead, add the following import to your preload script:

```ts
// src/preload.ts
import '@datadog/electron-sdk/preload';
```

This ensures the bridge code is bundled into your app's `preload.js` and included in the final package.

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

### Operation Monitoring _(experimental)_

Operation Monitoring lets you track the lifecycle of critical user-facing workflows
(login, checkout, file upload, video playback, …) by emitting paired `start` / `end`
steps. The backend correlates the steps by `name` (and optional `operationKey`) and
exposes them as a single Operation in the RUM UI.

> ⚗️ This API is in preview and the signatures may change before stable release.

```ts
import { startFeatureOperation, succeedFeatureOperation, failFeatureOperation } from '@datadog/electron-sdk';

// Simple operation
startFeatureOperation('checkout');
try {
  await runCheckout();
  succeedFeatureOperation('checkout');
} catch (error) {
  failFeatureOperation('checkout', 'error');
}

// Parallel operations sharing a name — distinguished by `operationKey`
startFeatureOperation('upload', { operationKey: 'profile_pic' });
startFeatureOperation('upload', { operationKey: 'cover_photo' });
succeedFeatureOperation('upload', { operationKey: 'profile_pic' });
failFeatureOperation('upload', 'abandoned', { operationKey: 'cover_photo' });
```

#### API

| Function                  | Signature                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `startFeatureOperation`   | `(name: string, options?: FeatureOperationOptions) => void`                               |
| `succeedFeatureOperation` | `(name: string, options?: FeatureOperationOptions) => void`                               |
| `failFeatureOperation`    | `(name: string, failureReason: FailureReason, options?: FeatureOperationOptions) => void` |

```ts
type FailureReason = 'error' | 'abandoned' | 'other';

interface FeatureOperationOptions {
  /** Distinguishes parallel operations sharing the same `name`. */
  operationKey?: string;
  /** Free-form attributes merged into the event's `context`. */
  context?: Record<string, unknown>;
  /** Free-form description attached to `vital.description`. */
  description?: string;
}
```

#### Cross-process usage

The renderer process keeps using `@datadog/browser-rum` directly (with the
`feature_operation_vital` experimental flag enabled on its init). API signatures
match exactly, so you can start an operation in one process and complete it in the
other — the backend correlates steps by `name` + `operationKey`.

#### Validation

- Blank `name` or blank `operationKey` are rejected and an error is logged; no event
  is emitted.
- Non-string `name` or non-object `options` are rejected the same way (defensive
  guard for JS callers that bypass the TypeScript signatures).
- Names containing characters outside `[\w.@$-]*` (letters, digits, `_`, `.`, `@`,
  `$`, `-`) emit a warning but the event is still sent — the backend is the source
  of truth on the character-set policy.

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
