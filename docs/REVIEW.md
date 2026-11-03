# Code Review Guide

What to look for when reviewing a PR. Linters, the formatter, and the type checker already run in CI: don't repeat what
they enforce. Check the diff against `docs/CONVENTIONS.md` and `docs/TESTING.md`, then focus on the project-specific
risks below.

## What to look for

### Async ordering and lifecycle

IPC messages, file I/O, session events, and span callbacks all interleave. Look for:

- **Race conditions**: async calls that are not awaited or whose results can arrive out of order (e.g. creating a new
  session before the old one is flushed, recovering batch files that collide with existing ones).
- **Unserialized writes**: concurrent writes to shared state or disk without serialization.
- **Init and shutdown ordering**: preload registration completes before windows are created; async initialization
  completes before events can flow; before-quit produces the final segments and spans before the last transport flush,
  and waits for in-flight uploads.
- **Re-entrancy**: calling a method again does not stack another pending listener or timer.
- **Renderer lifecycle**: events or queued IPC arriving after a renderer is closed, crash revival, a renderer process
  shared by several windows, destroyed `WebContents` retained in memory.

### Session and time attribution

Resolve the session and contexts from the event's timestamp, not from the current state: an event recorded before a
session renewal belongs to the previous session. The one exception is renderer view events, see
`RendererViewStartTime` (`src/assembly/RendererViewStartTime.ts`).

### Data at boundaries

- Files recovered from disk can be truncated by a crash: drop them rather than throw.
- Size limits are expressed in bytes: measure the UTF-8 encoded size, not `string.length`.

See the error handling rules in `docs/CONVENTIONS.md`.

### Privacy and consent

- Tracking consent gates fail closed: no data reaches authorized storage or the network without consent, and a failed
  clear is retried.
- Identity and customer data are not retained on disk past the session timeout: history is kept only as long as needed
  to attribute past events and crashes.

### SDK observability

All callbacks driven by Node.js or Electron (IPC handlers, `diagnostics_channel` subscribers, event listeners) must be
wrapped with `monitor()` so errors are captured by telemetry rather than silently lost. This applies to Promise
`.then`/`.catch` callbacks into SDK code too.

Use the SDK's `setTimeout` and `setInterval` from `src/domain/telemetry/timer.ts` instead of raw
`global.setTimeout`/`global.setInterval`.

See `monitor` and `callMonitored` in `src/domain/telemetry/Telemetry.ts`.

### Backward compatibility

Breaking changes must be intentional and flagged in the PR title (💥). Since 1.0, they require a major version, so
they are only acceptable when one is planned. Watch for:

- Public API changes (renamed/removed methods, changed signatures in `InitConfiguration` or public classes).
- Event field renames or removals: downstream dashboards and monitors rely on stable field names.
- Changed default values for configuration options.

### Docs drift

README, `docs/ARCHITECTURE.md`, and the PR description match the final code, not an earlier iteration of the PR.

### Bundler and packager coverage

Changes to bundler plugin code (`vite-plugin`, `webpack-plugin`, `esbuild-plugin`), preload resolution, dd-trace
initialization order, or dependency copying may behave differently across the integration apps in
`e2e/integration/apps/`.

Check whether the change warrants a new or updated scenario in `e2e/integration/scenarios/`. One representative app is
enough unless the change is toolchain-specific.

## What not to flag

- A finding already fixed, or dismissed with a reason, earlier on the same PR.
- Exotic timing or environments: rapid state flips during async work, a wall clock moving backward, several sessions
  within the same millisecond.
- Unrealistic parsing edge cases (e.g. an own `__proto__` key, percent-encoded unreserved characters in a host).
- Performance concerns without evidence (a measurement or a hot path).
- Issues that predate the PR, or that the next PR of a stack handles.
- Missing `CHANGELOG.md` entries: the changelog is generated at release time.
