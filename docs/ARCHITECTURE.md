# Architecture

SDK design patterns and event pipeline.

## Two-Tier Configuration

`InitConfiguration` (user API) → `buildConfiguration()` → `Configuration` (internal, validated).

- **Required fields** (e.g. `clientToken`): validation returns `undefined` to signal initialization should abort — no exceptions thrown.
- **Optional fields** (e.g. `env`): invalid values silently fall back to `undefined`.
- **Derived fields** (e.g. `intakeUrl`): computed from validated inputs during `buildConfiguration()`.

See `src/config.ts`.

## Event Pipeline

The `EventManager` provides a handler-based pipeline for processing events.

### Event Kinds

- **`RawEvent`** — Emitted by domain code (e.g., `DummyMainView`), contains event-specific data and a source (`MAIN` | `RENDERER`).
- **`ServerEvent`** — Ready for transport, tagged with a track (`RUM` | `LOGS`).
- **`LifecycleEvent`** — Internal signals (e.g., `END_USER_ACTIVITY`), not sent to intake.

### Handler Pattern

Handlers register on `EventManager` with `canHandle` (type guard) and `handle` (processing + optional `notify` callback to emit derived events):

```
RawEvent → [Assembly handler] → ServerEvent → [Transport handler] → HTTP intake
```

See `src/event/` and `src/domain/assembly.ts`.
