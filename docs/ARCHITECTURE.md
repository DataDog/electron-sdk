# Architecture

Describes general patterns with examples — detailed component documentation lives as JSDoc on the classes themselves (e.g., `SessionManager`, `ViewCollection`).

## Overview

```mermaid
flowchart LR
    subgraph Sources
        RUM[RUM collection]
        TEL[Telemetry]
    end

    subgraph Assembly
        HOOKS{Format Hooks}
        COMBINE[combine]
    end

    subgraph "Hook Providers"
        CC[commonContext]
        SC[sessionContext]
        VC[viewContext]
    end

    subgraph Transport
        BM[BatchManager]
        BP[BatchProducer]
        BC[BatchConsumer]
    end

    RUM -- RawRumEvent --> COMBINE
    TEL -- RawTelemetryEvent --> COMBINE
    CC -. "application.id, service, ..." .-> HOOKS
    SC -. "session.id" .-> HOOKS
    VC -. "view.id, view.name, ..." .-> HOOKS
    HOOKS --> COMBINE
    COMBINE -- ServerEvent --> BM
    BM --> BP
    BM --> BC
    BP -. "write" .-> DISK[Disk]
    BC -. "read" .-> DISK[Disk]
    BC -. "send" .-> INT[HTTP intake]
```

## Event Pipeline

The `EventManager` provides a handler-based pipeline for processing events.

### Event Kinds

- **`RawEvent`** — Emitted by domain code, contains event-specific data, a source (`MAIN` | `RENDERER`), and a format (`RUM` | `TELEMETRY`).
- **`ServerEvent`** — Ready for transport, tagged with a track (`RUM` | `LOGS`).
- **`LifecycleEvent`** — Internal signals (e.g., `END_USER_ACTIVITY`, `SESSION_RENEW`), not sent to intake.

### Handler Pattern

Handlers register on `EventManager` with `canHandle` (type guard) and `handle` (processing + optional `notify` callback to emit derived events).

See `src/event/` and `src/domain/assembly.ts`.

## Assembly and Format Hooks

The `Assembly` handler transforms `RawEvent` into `ServerEvent` by enriching raw data with contextual properties via format hooks.

### Format Hooks

`createFormatHooks()` creates per-format hook pairs (`registerRum`/`triggerRum`, `registerTelemetry`/`triggerTelemetry`). Each hook callback can return:

- **Partial data** — merged into the event via `combine()`
- **`DISCARDED`** — drops the event entirely
- **`SKIPPED`** — this callback has nothing to contribute

Hooks are used by different parts of the SDK to attach their context (e.g., `registerCommonContext` adds `session`, `application`, `service`; `sessionManager` adds `session.id`).

See `src/domain/hooks/` and `src/domain/commonContext.ts`.

## SDK Telemetry

Internal observability for the SDK itself. Captures SDK errors and sends them as telemetry events.

- **Sampling**: controlled by `telemetrySampleRate` config, evaluated once per session.
- **Rate limiting**: capped per session, counter resets on `SESSION_RENEW`.
- **Error collection**: wrappers catch uncaught errors and errors in callbacks, emitting them as telemetry events.

See `src/domain/telemetry/`.

## APM Tracing (dd-trace integration)

When `tracing: true` is set in the configuration, the SDK integrates with dd-trace (bundled) for HTTP resource collection and automatic preload injection.

### Early initialization (`@datadog/electron-sdk/init`)

dd-trace instruments modules by hooking `require()`. For this to work, it must be initialized **before** `require('electron')`. The SDK provides a dedicated entry point for this:

```typescript
import '@datadog/electron-sdk/init'; // must be first
import { app, BrowserWindow } from 'electron';
```

This entry point initializes dd-trace with the `electron` exporter and silently no-ops if dd-trace is unavailable. Because it runs before `electron` is imported, dd-trace can:

- Hook `require('electron')` to wrap `BrowserWindow` for automatic preload injection
- Instrument Electron's `net` module for HTTP span collection

### How tracing works

dd-trace's `electron` exporter publishes normalized spans to a Node.js diagnostics channel (`datadog:apm:electron:export`) instead of sending them to a local Datadog Agent. The `ResourceConverter` subscribes to this channel, filters for HTTP spans, excludes the SDK's own intake requests, and converts them into `RawRumResource` events routed through the standard event pipeline.

```
Instrumented code (fetch, net.request)
    ↓
dd-trace creates spans
    ↓
ElectronExporter → diagnostics channel 'datadog:apm:electron:export'
    ↓
ResourceConverter (filters + converts)
    ↓
EventManager → Assembly → Transport → Datadog intake
```

Service, env, and version are not configured on the tracer — the SDK's Assembly hooks enrich RUM events with those values from the SDK config.

Trace and span IDs are converted to **decimal strings** (`Identifier.toString(10)`) as required by the RUM intake for APM correlation.

### Supported HTTP integrations

In Electron, only these dd-trace integrations produce HTTP spans:

- **`fetch`** — global `fetch()` (patched at runtime)
- **`electron` (net)** — `net.request()` / `net.fetch()` (Electron-specific API)

Node's `http`/`https` modules cannot be instrumented in bundled Electron apps because they load before dd-trace's hooks activate.

### Preload injection

dd-trace wraps `BrowserWindow` to automatically inject a preload script via `session.registerPreloadScript()`. This preload sets up the `DatadogEventBridge` — the same bridge the SDK's own `preload-auto.cjs` provides. This works in both bundled and non-bundled environments because `electron` is always a runtime module (never bundled).

The SDK's own `registerPreload()` is not used when the `@datadog/electron-sdk/init` entry point handles preload injection. Both preloads have a double-registration guard (`if (window.DatadogEventBridge) return`), so they are safe to run together in any order.

See `src/domain/tracing/` and `src/entries/init.ts`.

## Two-Tier Configuration

`InitConfiguration` (user API) → `buildConfiguration()` → `Configuration` (internal, validated).

- **Required fields** (e.g. `clientToken`): validation returns `undefined` to signal initialization should abort — no exceptions thrown.
- **Optional fields** (e.g. `env`): invalid values silently fall back to `undefined`.

See `src/config.ts`.
