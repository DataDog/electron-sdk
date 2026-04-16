# Child Process Monitoring — Conclusion & Next Steps

The prototype (docs 00-04) validated feasibility across all three instrumentation mechanisms: child_process APIs, Electron utility processes, and renderer process tracking. This document synthesizes findings into concrete work items, organized by topic with value/complexity ratings, and proposes a sequencing that accounts for the in-progress dd-trace integration.

## Overview

| Topic                                             | Value        | Complexity  |
| ------------------------------------------------- | ------------ | ----------- |
| Data model agreement                              | Prerequisite | Medium      |
| dd-trace integration evaluation                   | Strategic    | Easy        |
| exec/spawn/execFile monkey-patching (or dd-trace) | Very High    | Challenging |
| exec/spawn/execFile collection                    | Very High    | Easy-Medium |
| Utility process monitoring                        | High         | Medium      |
| Renderer process views                            | High         | Medium      |
| Bugs identified                                   | Medium       | Easy        |
| Playground improvements to extract                | Low          | Easy        |

---

## 1. Data Model Agreement

**Value: Prerequisite | Complexity: Medium**

Schema extensions are needed to move data out of `context.*` (customer-owned in production) into proper schema fields. This gates production implementation of all instrumentation topics. The prototype validated that the RUM event model can represent Electron processes — but the specific schema fields need agreement before implementation.

### Processes as Views

Every Electron process becomes a RUM View, providing built-in correlation (`view.id`), memory/CPU fields (from mobile SDK schema), error/resource/action counters, and container hierarchy for process nesting.

**View naming**: `"{ProcessType}: {identifier}"` — e.g., `"Utility: dd-proto-worker"`, `"Renderer: {pageTitle or webContentsId}"`, `"GPU"`

**Schema fields needed:**

| Prototype (context) | Production schema needed | Purpose                               |
| ------------------- | ------------------------ | ------------------------------------- |
| `view.context.pid`  | `view.process.pid`       | Process identity on all process views |

**Alternatives considered:**

- Using RUM Sessions per process instead of Views — rejected because sessions lack the container hierarchy needed for renderer → page view nesting, and would break the single-session-per-app model
- Using custom Actions instead of Views — rejected because Actions don't support metrics polling, and while events can be attached via `action.id`, Views provide richer built-in semantics (duration, counters, container hierarchy)
- Using Feature Operations instead of Views — rejected because operations sit above views in the hierarchy (designed for user-facing workflows spanning multiple pages), while processes sit below/alongside views as infrastructure containers. Operations also lack metrics polling and container hierarchy

**Open decisions:**

- **CPU metrics unit mismatch**: RUM schema uses `cpu_ticks_per_second` (mobile SDK), Electron provides `percentCPUUsage` (%). Need conversion formula or new schema field
- **UI labels**: RUM Explorer shows "Load Page" for all views. Process views need a `view.type` distinction or backend/UI change to display correctly
- **Metrics polling frequency**: prototype uses 2s. Align with mobile SDK approach and evaluate overhead tradeoff

### Command Execution as Resource

Child process spawns (`spawn`, `exec`, `execFile`) map to RUM Resources, similar to how HTTP requests are tracked. This gives duration, status, and error correlation for free.

**Resource mapping**: `type: "native"`, `url: "{method}://{command}"` (e.g., `spawn://ls`, `exec://git status`)

**Schema fields needed:**

| Prototype (context)           | Production schema needed      | Purpose               |
| ----------------------------- | ----------------------------- | --------------------- |
| `resource.context.args`       | `resource.process.args`       | Command arguments     |
| `resource.context.cwd`        | `resource.process.cwd`        | Working directory     |
| `resource.context.error_code` | `resource.process.error_code` | Error code on failure |

**Why Resources and not Views?** Unlike Electron processes (utility, renderer) which are long-lived with ongoing metrics (memory, CPU), command executions are short-lived operations with a fixed set of data points (command, args, duration, exit code). This maps naturally to Resources — similar to HTTP requests — rather than Views which are designed for ongoing observation with attached sub-events.

**Alternatives considered:**

- Using RUM Actions instead of Resources — rejected because Actions don't have duration/status_code semantics and would lose the parallel with HTTP request tracking
- Using RUM Errors for failed commands — rejected because the Resource already carries status_code and error context; a separate Error event would be redundant
- Using Feature Operations instead of Resources — rejected because operations are designed for user-facing workflows (checkout, profile loading), not high-frequency system-level commands. Every `git status` spawn would flood the operations catalog. Operations also lack `status_code` and `url` scheme that Resources provide

**Open decisions:**

- **Resource status codes**: exit codes (-1, -2, 0) not displayed as prominently as HTTP status codes in the UI. May need UI/backend support
- **Sensitive data scrubbing**: command args may contain secrets. Need scrubbing strategy before shipping

### Other Schema Extensions

| Prototype (context)       | Production schema needed  | Used by                                 |
| ------------------------- | ------------------------- | --------------------------------------- |
| `error.context.reason`    | `error.process.reason`    | Crash/exit reason from lifecycle events |
| `error.context.exit_code` | `error.process.exit_code` | Exit code from lifecycle events         |

---

## 2. dd-trace Integration Evaluation

**Value: Strategic | Complexity: Easy**

A dd-trace integration is in progress ([electron-sdk#95](https://github.com/DataDog/electron-sdk/pull/95), [dd-trace-js#7002](https://github.com/DataDog/dd-trace-js/pull/7002)). The monkey-patching of `child_process` (topic 3) is the most challenging work item — dd-trace could eliminate it entirely. Worth exploring in parallel with schema discussions.

### Current state of the integration (reviewed)

The Electron dd-trace integration currently covers:

- **HTTP spans**: `fetch()`, `net.request()`, `net.fetch()` → converted to RUM Resources via `ResourceConverter`
- **IPC spans**: `ipcMain` / `ipcRenderer` send/receive → `electron.main.send/receive`, `electron.renderer.send/receive`
- **BrowserWindow wrapping**: injects preload script for renderer IPC tracing (not for lifecycle monitoring)
- **Architecture**: dd-trace → ElectronExporter → diagnostics_channel `datadog:apm:electron:export` → SDK `ResourceConverter` → RUM events

### What the integration does NOT currently cover

- **child_process** (spawn/exec/execFile) — dd-trace has a separate `child_process` plugin with `command_execution` spans, but it is not enabled in the Electron integration. Could potentially be enabled.
- **utilityProcess** — Electron-specific, no dd-trace plugin exists
- **Lifecycle events** — `child-process-gone`, `render-process-gone`, `getAppMetrics()` — Electron-specific, not covered
- **Renderer process lifecycle** — BrowserWindow wrapping is for preload injection only, not creation/crash/metrics tracking

### Remaining questions

- Can the existing dd-trace `child_process` plugin be enabled in the Electron context to get `command_execution` spans?
- If so, does the diagnostics_channel export pattern work for these spans too?

### Decision outcome

- **If `child_process` plugin can be enabled**: skip standalone monkey-patching, convert `command_execution` spans → RUM Resources via the existing `ResourceConverter` pattern
- **If not viable**: implement standalone monkey-patching with RITM + shimmer (not raw `Object.defineProperty`)
- **Either way**: utility process, renderer views, and lifecycle events need standalone implementation — dd-trace doesn't cover these Electron-specific APIs

---

## 3. exec/spawn/execFile Monkey-Patching (or dd-trace)

**Value: Very High | Complexity: Challenging**

Intercepting Node.js built-in `child_process` module requires monkey-patching with significant fragility and maintenance concerns. This complexity is **exclusive to `child_process`** — utility process and renderer instrumentation use simple Electron API wrapping and event listeners with no bundler issues. This is where dd-trace could help the most. Prerequisite for the collection topic below.

### Tasks

- Evaluate dd-trace integration first (see topic 2) — if it covers child_process, skip standalone monkey-patching
- If standalone: implement with RITM + shimmer instead of raw `Object.defineProperty` for bundler robustness
- Test with all bundler configurations (Webpack, esbuild, Vite)

### Key findings to keep in mind

- `import * as mod` (Rollup `__importStar`) creates non-configurable getters — patching has no effect. Must use `require()` to get the actual CommonJS module
- `diagnostics_channel` for child_process does NOT exist in Node.js v22.21.1 (Electron 39)
- Libraries like shimmer and RITM (require-in-the-middle) handle bundler edge cases that raw `Object.defineProperty` does not

### dd-trace impact

dd-trace has a `child_process` plugin that generates `command_execution` spans via RITM + shimmer. It is not currently enabled in the Electron integration, but could potentially be. If enabled, this entire topic is eliminated — the existing `ResourceConverter` pattern (diagnostics_channel → RUM events) would handle the conversion. **This topic should wait for the dd-trace evaluation.**

---

## 4. exec/spawn/execFile Collection

**Value: Very High | Complexity: Easy-Medium**

High customer likelihood (VS Code spawns constantly), rich data (command, args, duration, exit code). The collection logic itself — wrapping calls, capturing data, emitting RUM Resources — is straightforward once the instrumentation hook is in place (topic 3).

### Tasks

- Wrap spawn/exec/execFile calls to capture: command, args, duration, exit code, errors
- Emit RUM Resources with `type: "native"`, `url: "{method}://{command}"`, `status_code` = exit code
- Deduplication: `exec` → `execFile` → internal spawn chain fires at every level. Prototype uses reentrant `insideHigherLevelCall` flag + one-shot `emitted` flag for close+error double-emission
- Handle `util.promisify(exec)` — bypasses wrapper and calls `execFile` directly, needs symbol copying
- Self-instrumentation filtering: SDK's own `execFile('sw_vers')` gets captured. Current allowlist is fragile — prefer keeping reference to original unpatched function for SDK-internal calls

### Key findings to keep in mind

- `exec` callback errors have string codes (e.g., `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), not just numbers
- All async and sync variants need coverage: `spawn`, `exec`, `execFile`, `spawnSync`, `execSync`, `execFileSync`

### dd-trace impact

If dd-trace provides `command_execution` spans, the collection logic simplifies to a span → RUM Resource conversion, eliminating deduplication and self-instrumentation concerns entirely.

---

## 5. Utility Process Monitoring

**Value: High | Complexity: Medium**

Growing Electron API adoption — VS Code has migrated its extension host, language servers, file watcher, and search from `child_process.fork` to `utilityProcess`. Fork wrapper is straightforward. Main-process-only collection captures ~80% of useful telemetry with near-zero overhead.

### Tasks

- Implement fork wrapper via `Object.defineProperty` on `utilityProcess` singleton
- Choose telemetry channel: dedicated MessagePort (recommended) over parentPort piggyback
- Wire `app.on('child-process-gone')` to emit crash errors on the utility process View
- Implement `getAppMetrics()` polling for memory metrics (memory works, CPU unit mismatch — see data model topic 1)
- Map utility process lifecycle to RUM View + Action (clean exit) / Error (abnormal exit)
- Investigate crash dump processing — WASM minidump processor fails on utility process dumps (missing `crashing_thread` field, expects main-process format)

### Key findings to keep in mind

- `child-process-gone` cannot distinguish crash from intentional `process.exit(1)` — both produce `reason: abnormal-exit`
- `serviceName` in `getAppMetrics()` shows `node.mojom.NodeService` (Chromium internal), not user's serviceName — use `name` field from fork options instead
- `exitCode` differs: `child-process-gone` reports 256 instead of 1 for `process.exit(1)`
- parentPort piggyback leaks `{ __dd: true }` messages into customer `message` handlers (EventEmitter delivers to all listeners) — dedicated MessagePort avoids this
- Crash error ordering: error message via parentPort arrives BEFORE `child-process-gone` event — useful for enrichment
- Electron always runs one default Utility process (`network.mojom.NetworkService`) — needs filtering or explicit handling

### Instrumentation approach

No monkey-patching needed here — `utilityProcess` is an Electron singleton, wrapping `fork()` via `Object.defineProperty` is straightforward and doesn't have the bundler/RITM concerns that `child_process` has. Lifecycle events (`child-process-gone`, `getAppMetrics`) are pure event listeners.

dd-trace does not cover any of these Electron-specific APIs. Future consideration: if utility processes run dd-trace internally, their spans could flow to main process via the telemetry channel.

---

## 6. Renderer Process Views

**Value: High | Complexity: Medium**

Enables container hierarchy (renderer view → browser-rum page views) and crash tracking for renderer processes.

### Tasks

- Detect renderer creation via `web-contents-created` + `did-start-navigation`
- Create RUM Views for each renderer with name `"Renderer: webContentsId={id}"`
- Wire `app.on('render-process-gone')` to emit crash errors on the renderer View
- Implement `getAppMetrics()` polling for renderer process metrics
- Implement container hierarchy: set `container.view.id` on browser-rum events to the renderer's process View
- Add `senderPid` to `RawRumEvent`, extracted from `IpcMainEvent.sender.getOSProcessId()` (BridgeHandler change)
- Maintain proactive `webContents.id → pid` mapping — `getOSProcessId()` returns 0 after crash
- Investigate renderer crash dump handling — existing `CrashCollection` may not handle them correctly, need to verify dump format and view association

### Key findings to keep in mind

- `render-process-gone` does NOT fire for normal window close — only abnormal terminations (crash, killed, OOM)
- `render-process-gone` provides `webContentsId` for window correlation
- `percentCPUUsage` returns 0 on first call, meaningful values only after second poll
- Renderer view must predate browser-rum events — use early detection + lazy creation from Assembly
- Alternative timing approach: create renderer view at bridge level before Assembly for earliest interception

### Instrumentation approach

No monkey-patching needed — renderer detection uses Electron event listeners (`web-contents-created`, `render-process-gone`, `getAppMetrics`). No bundler concerns.

The dd-trace Electron integration wraps `BrowserWindow` to inject a preload script for IPC tracing, but does not provide renderer lifecycle data (creation, crash, metrics). Our standalone implementation is needed regardless.

---

## 7. Bugs Identified

**Value: Medium | Complexity: Easy**

Pre-existing bugs found during the prototype that should be fixed independently.

### Tasks

- **View date bug**: `ViewCollection` does not set `date` on raw view events. `commonContext` hook overwrites with assembly-time timestamp instead of view creation time. Fix: set `date: startTime` on the raw event
- **Application path sanitization** ([RUM-15282](https://datadoghq.atlassian.net/browse/RUM-15282)): events leak full filesystem paths (e.g., `/Users/.../playground/dist/index.html`). Prototype findings: stripping path entirely (empty replacement) works; `[APP_PATH]` placeholder approach breaks Datadog UI. Should feed these findings back into the existing ticket

---

## 8. Playground Improvements to Extract

**Value: Low | Complexity: Easy**

Small improvements made during prototyping that are worth keeping.

### Tasks

- Extract Playwright + mock intake test harness infrastructure (without prototype-specific scenarios)
- Extract "copy session id" button for debugging convenience

---

## Sequencing

### Phase 1 — No blockers, can start immediately and in parallel

- **dd-trace evaluation** — determines Phase 2 approach for exec/spawn. Small effort, high impact on planning
- **Data model proposal** — draft schema extensions, submit for agreement. Gates Phase 2 production work
- **Bug fixes** — view date, path sanitization. Independent, low risk
- **Playground extraction** — test harness, copy session id. Independent

### Phase 2 — After Phase 1 gates clear

- **Utility process monitoring** — depends on data model agreement
- **Renderer process views** — depends on data model agreement
- **exec/spawn monkey-patching (or dd-trace)** — depends on dd-trace evaluation. If dd-trace covers it, skip entirely
- **exec/spawn collection** — depends on data model agreement + monkey-patching/dd-trace (topic 3)

### Phase 3 — Deferred investigation

- **Crash dump processing** — utility + renderer crash dumps need WASM processor investigation
- **CPU metrics alignment** — needs mobile SDK alignment + backend/UI support
- **worker_threads** — not prototyped, lower priority

### Dependencies

```
dd-trace evaluation ──→ exec/spawn monkey-patching (or dd-trace) ─┐
                                                                  ├──→ exec/spawn collection
data model agreement ─────────────────────────────────────────────┘
                              ├──→ utility process monitoring
                              └──→ renderer process views

bug fixes, playground extraction ──→ (independent)
```

### Parallelization opportunities

- All Phase 1 items are independent of each other
- In Phase 2, utility process and renderer views can be parallelized (different instrumentation targets, shared data model dependency)
- exec/spawn collection can be parallelized with utility/renderer once monkey-patching (or dd-trace) is resolved
- exec/spawn monkey-patching is only needed if dd-trace doesn't cover it
