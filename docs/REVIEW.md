# Code Review Guide

What to look for when reviewing a PR. Linters, the formatter, and the type checker already run in CI — don't
repeat what they enforce. Focus on the project-specific concerns below.

## What to look for

### Async correctness

Electron SDK code is highly concurrent: IPC messages, file I/O, session events, and span callbacks
all interleave. Look for:

- **Race conditions**: async calls that are not awaited or whose results can arrive out of order (e.g.
  creating a new session before the old one is flushed, recovering batch files that collide with
  existing ones).
- **Unserialized writes**: concurrent writes to shared state or disk without serialization.
- **Preload timing**: preload registration must complete before windows are created; async
  initialization must complete before events can flow.

### Error handling

The SDK favors observable failures over silent ones:

- Prefer throwing or reporting via telemetry over defensive null-checks for invalid payloads. Unhandled errors are
  captured by the SDK's error wrapper and reported as telemetry.
- Validate external inputs (IPC messages, public API calls) early and fail loudly. Internal code can
  trust its invariants.
- Don't introduce `?.` or fallback values for conditions that should not be possible — surface them
  instead.

### SDK observability

All callbacks driven by Node.js or Electron (IPC handlers, `diagnostics_channel` subscribers, event
listeners) must be wrapped with `monitor()` so errors are captured by telemetry rather than
silently lost. This applies to Promise `.then`/`.catch` callbacks into SDK code too.

Use the SDK's `setTimeout`, `setInterval`, and `throttle` from `src/domain/telemetry/timer.ts`
instead of raw `global.setTimeout`/`global.setInterval`.

See `monitor` and `callMonitored` in `src/domain/telemetry/Telemetry.ts`.

### Backward compatibility

Breaking changes must be intentional. Watch for:

- Public API changes (renamed/removed methods, changed signatures in `InitConfiguration` or public
  classes).
- Event field renames or removals — downstream dashboards and monitors rely on stable field names.
- Changed default values for configuration options.

### Documentation

- New or modified classes should have a JSDoc comment explaining their responsibility and role in
  the system.
- New or modified public APIs should have a JSDoc comment with a clear description and at least one
  `@example`.

See `docs/CONVENTIONS.md` for full JSDoc conventions.

### Test quality

- **No redundant assertions**: multiple tests asserting the same behavior with different inputs add
  maintenance cost without coverage benefit — one parametrized case or a single representative
  example is enough.
- **Simple mocks**: avoid unnecessary indirection in test doubles; mock only what is needed.

### Bundler and packager coverage

Changes to bundler plugin code (`vite-plugin`, `webpack-plugin`, `esbuild-plugin`), preload
resolution, dd-trace initialization order, or dependency copying may behave differently across the
supported integration apps (electron-builder-vite, electron-vite, electron-vite-esm,
forge-esbuild-cjs, forge-esbuild-esm, forge-vite, forge-webpack).

Check whether the change warrants a new or updated scenario in `e2e/integration/scenarios/` and
whether the affected apps are covered.

### Reuse over reinvention

Before adding a new utility, check `@datadog/browser-core` and `@datadog/js-core` — utilities are
progressively migrating to `@datadog/js-core`, so check both.
