# Prototype Findings: Child Process RUM Telemetry

Findings from implementing the RUM concept mapping (`_03_rum-mapping.md`) as a working prototype.

## What was built

| Step | Feature                                                            | Validated                                    |
| ---- | ------------------------------------------------------------------ | -------------------------------------------- |
| 0    | Playground test harness (Playwright + mock intake)                 | Smoke test: view event arrives               |
| 1    | `ChildProcessCollection` — spawn/exec/execFile as resources        | 4 scenarios (success, echo, ENOENT, timeout) |
| 2    | `UtilityProcessCollection` — utility processes as views            | Fork view + crash error                      |
| 3    | Performance metrics polling via `app.getAppMetrics()`              | memory_average/memory_max on utility views   |
| 4    | `RendererProcessCollection` — renderer views + container hierarchy | Renderer detection + crash error             |

11 Playwright scenarios total, all passing.

## Findings

### Monkey-patching

**Rollup namespace wrapper breaks `Object.defineProperty`.**
`import * as mod from 'node:child_process'` produces a Rollup namespace wrapper (`_interopNamespaceDefault`). Patching properties on the wrapper does not affect the real module — other consumers still see the original functions. **Fix**: use `require()` to get the actual CommonJS module object. This applies to any future monkey-patching in the SDK.

**`webContents.getOSProcessId()` returns 0 after renderer crash.**
By the time `render-process-gone` fires, the OS process is already dead and the pid accessor returns 0. **Fix**: maintain a `webContents.id → pid` mapping proactively during detection, before any crash occurs.

**exec/execFile/spawn call chain produces duplicate resource events.**
Node's `exec()` delegates to `execFile()` which delegates to `spawn()`. Since all three are patched, a single `exec()` call triggered instrumentation at every level. Additionally, a failed `spawn()` fires both `error` and `close` events. **Fix**: reentrant `insideHigherLevelCall` flag prevents lower-level patches from emitting when called from a higher-level wrapper; one-shot `emitted` flag prevents close+error double-emission on spawn.

### Event pipeline

**Container hierarchy requires sender identity.**
The bridge handler (`BridgeHandler`) had no notion of which renderer sent an event. To set `container.view.id` to the renderer's process view, we added `senderPid` to `RawRumEvent` and extracted it from `IpcMainEvent.sender.getOSProcessId()`. This is a production requirement — the main view ID was previously used for all renderers, which is incorrect for multi-window apps.

**Multiple view updates per process view.**
Each process view emits many updates (document versions 1, 2, 3…) as counters and metrics change. Tests and intake consumers need to filter for the specific version they care about (e.g., `is_active: false` for the final update).

**View date bug (pre-existing).**
`ViewCollection` did not set `date` on raw view events. The `commonContext` hook set `date: Date.now()` at assembly time, so every view update got the timestamp of the latest update instead of the view's creation time. Fixed by setting `date: startTime` on the raw event.

### Renderer process view timing

**Renderer view must predate browser-rum events.**
The renderer process view must start before (or at the same time as) the first browser-rum view event from that renderer. Otherwise the timeline shows the process view appearing after the events it contains.

**Approach implemented (prototype):**

1. **Early detection** — listen to `app.on('web-contents-created')` then `did-start-navigation` (fires before `did-finish-load`) for eager renderer tracking
2. **Lazy creation with backdating** — `getOrCreateRendererViewId(pid, eventDate)` creates the view on-demand from Assembly using the bridge event's `date` as `startTime`, guaranteeing the view predates the event

**Alternate approach for production:**
Create the renderer view at the bridge level (`BridgeHandler`) rather than Assembly. The bridge receives IPC messages before Assembly processes them, making it the earliest possible interception point. The bridge would call `getOrCreateRendererViewId(senderPid, eventDate)` directly, so the view exists before the event even reaches the Assembly pipeline.

### Memory and CPU metrics

**Memory uses existing RUM view fields.**
The RUM view schema already defines `view.memory_average` and `view.memory_max` (used by mobile SDKs). The prototype uses these directly — no schema extension needed for memory. Data comes from `app.getAppMetrics()` → `memory.workingSetSize` (current RSS in KB), sampled at each poll interval. For `memory_max`, `memory.peakWorkingSetSize` from the last sample could also be used as the OS-level peak.

**CPU metrics not prototyped — unit mismatch needs investigation.**
The RUM schema has `view.cpu_ticks_count` and `view.cpu_ticks_per_second` (mobile SDK fields). Electron provides `cpu.cumulativeCPUUsage` (total CPU seconds) and `cpu.percentCPUUsage` (% since last call). These measure the same concept (total CPU consumption and average intensity) but in different units (seconds vs ticks).

**Both memory and CPU fields are mobile SDK fields** — it's unclear how Datadog displays them for non-mobile platforms. Needs further investigation before production to confirm these fields are rendered correctly in the RUM Explorer and Session Replay for Electron views.

### Schema gaps

The RUM mapping doc anticipated these, and the prototype confirms them:

| Current location              | What's stored               | Production schema needed      |
| ----------------------------- | --------------------------- | ----------------------------- |
| `resource.context.args`       | Command arguments           | `resource.process.args`       |
| `resource.context.cwd`        | Working directory           | `resource.process.cwd`        |
| `resource.context.error_code` | errno (e.g., ENOENT)        | `resource.process.error_code` |
| `view.context.pid`            | OS process ID               | `view.process.pid`            |
| `error.context.reason`        | Gone reason (crashed, oom…) | `error.process.reason`        |
| `error.context.exit_code`     | Exit code                   | `error.process.exit_code`     |

### Self-instrumentation

The SDK calls `execFile('sw_vers')` internally for user-agent detection. This is filtered via an allowlist (`SELF_INSTRUMENTATION_COMMANDS`). The allowlist approach is fragile — any new internal child_process call must be manually added. Production alternatives:

- Thread a "skip instrumentation" flag through internal call sites
- Use the original (unpatched) function reference for SDK-internal calls

### Polling model

The prototype uses a 2s polling interval for metrics on both utility and renderer process views. Renderer detection itself is event-driven (`web-contents-created` + `did-start-navigation`), with lazy creation from bridge events as fallback. Tradeoffs for metrics polling:

- **Faster polling** = fresher memory data, but more CPU and more view update events
- **Slower polling** = less overhead, but stale memory readings

Production should make the interval configurable.

### exec error codes

`exec` callback errors have `error.code` which can be a string (e.g., `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`) rather than a number. The prototype handles this with a fallback to `-1` for `status_code`, but production should distinguish errno strings from numeric exit codes.

## Known issues and open questions

### Renderer crash processing not investigated

The prototype emits an error event on `render-process-gone`, but no investigation was done on whether the existing `CrashCollection` (minidump processing) correctly handles renderer crash dumps. Open questions: does the crash dump get associated to the correct view (renderer process view vs main view)? Does it need extra wiring?

### Utility process crash dumps fail to process

When a utility process crashes, the existing `CrashCollection` attempts to process the minidump but fails:

```
Failed to process crash dump: .../Crashpad/pending/8b1e6e13-....dmp
TypeError: Cannot read properties of undefined (reading 'crashing_thread')
    at formatThreads (dist/index.cjs:1526:32)
    at buildCrashErrorEvent (dist/index.cjs:1472:21)
    at CrashCollection.processCrashFiles (dist/index.cjs:1436:27)
```

The WASM minidump processor likely expects a main-process crash dump format. Utility process crash dumps may have a different structure (missing `crashing_thread`). Needs investigation when we want to capture detailed crash reports for utility processes.

### UI displays "Page" instead of "Process" for views

The Datadog RUM Explorer labels all views as "Load Page ..." which is misleading for process views (e.g., "Load Page Utility: dd-demo-fork"). The `view.name` is set correctly but the UI prepends "Load Page" to all view events. This is a Datadog platform behavior — may need a different `view.type` or a schema extension to distinguish process views from page views.

### UI does not display resource status codes clearly

The RUM Explorer does not render `resource.status_code` prominently for native resources. Exit codes like `0`, `-1`, `-2` from child processes are not displayed as clearly as HTTP status codes (200, 404, etc.) would be. This is a display limitation — the data is correct in the events.

## Architecture summary

```
ChildProcessCollection          → patches require('node:child_process')
                                  emits RawRumResource on completion
                                  reentrant guard deduplicates exec→execFile→spawn chain

UtilityProcessCollection        → patches utilityProcess.fork()
                                  emits RawRumView (process as view)
                                  emits RawRumAction (clean exit)
                                  emits RawRumError (abnormal exit / crash)
                                  polls app.getAppMetrics() for memory

RendererProcessCollection       → detects renderers via web-contents-created + did-start-navigation
                                  lazy creation from Assembly via getOrCreateRendererViewId
                                  emits RawRumView (renderer as view)
                                  emits RawRumError (render-process-gone)
                                  polls app.getAppMetrics() for memory

Assembly (modified)             → uses senderPid + getRendererContainerViewId
                                  to set container.view.id on renderer events
                                  passes event date for renderer view backdating

BridgeHandler (modified)        → extracts sender pid from IpcMainEvent
```

All events flow through the existing pipeline: EventManager → Assembly → Transport → intake.
