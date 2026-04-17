# Child Process Monitoring — Landscape Survey

Research hub for evaluating how the Datadog Electron SDK could monitor Electron child processes.

## Priority Matrix

> Updated after prototyping. See `prototype-child-processes_01_prototypes.md` for detailed findings.

| #   | Mechanism                           | Customer Likelihood | Monitoring Value | Feasibility (validated)                                                                                | **Priority**      |
| --- | ----------------------------------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ | ----------------- |
| 1   | Electron lifecycle events           | Universal           | High             | **Trivial.** Event listeners only, zero risk. Validated.                                               | **P0 — do first** |
| 2   | `child_process.spawn/exec/execFile` | Very High           | Very High        | **Feasible with caveats.** Requires `require()` + `Object.defineProperty`. Dedup and bundler concerns. | **P0**            |
| 3   | Electron `utilityProcess`           | High, growing fast  | High             | **Fully feasible.** Fork wrapper + MessagePort telemetry channel. Validated.                           | **P1**            |
| 4   | `child_process.fork`                | Medium, declining   | High             | Same approach as spawn. Not prototyped but expected to work.                                           | **P2**            |
| 5   | `worker_threads`                    | Moderate (~20-30%)  | Medium-High      | Not prototyped. Constructor patch likely works, child injection hard.                                  | **P3**            |
| 6   | `MessagePort/MessageChannel`        | Growing (~15-25%)   | Low as target    | **Validated as transport** for utility process telemetry. Skip as monitoring target.                   | N/A (transport)   |

---

## 1. child_process.spawn / exec / execFile

### What it is

Node.js APIs for executing external commands and binaries:

- **`spawn(command, args, options)`** — Launches a process, returns a `ChildProcess` with streaming stdio. No shell by default.
- **`exec(command, options, callback)`** — Runs a command in a shell, buffers stdout/stderr, delivers via callback. Also `util.promisify`-able.
- **`execFile(file, args, options, callback)`** — Like exec but without a shell (safer). Buffers output.
- Each has a sync variant (`spawnSync`, `execSync`, `execFileSync`) that blocks the event loop.

Internal call chain: `exec` → `execFile` → `spawn`. This matters for deduplication.

### Customer use cases

- **VS Code** — Spawns git processes constantly (status, diff, log, blame), language servers, terminal shells, build tools, linters, formatters. Extensions spawn arbitrary processes.
- **Cursor** — VS Code foundation + AI processes, local model inference, CLI tools.
- **GitHub Desktop** — Git commands for all repository operations.
- **Slack** — Native helpers for screen capture, call quality diagnostics.
- **Generic patterns** — Running CLI tools (ffmpeg, imagemagick, pandoc), platform utilities (sw_vers — our SDK does this), package managers, background daemons.

### Customer likelihood

**Very high.** Virtually every non-trivial Electron app uses these. Developer tools (IDEs, terminals, git clients) use them extremely heavily.

### Monitoring value

| Data                     | Value                                          |
| ------------------------ | ---------------------------------------------- |
| command + args           | Identify processes launched, detect anomalies  |
| Duration (spawn → exit)  | Performance monitoring, detect hangs           |
| Exit code + signal       | Error detection, crash monitoring              |
| stdout/stderr byte count | Resource usage, detect runaway output          |
| Error event details      | Failure classification (ENOENT, EACCES, EPERM) |
| Concurrency count        | Active child processes simultaneously          |
| options.shell            | Security signal (shell injection risk)         |
| options.cwd              | Context for relative commands                  |

### Instrumentation approach

Monkey-patch each method on the `child_process` module. Wrap the returned `ChildProcess` with event listeners for `exit`, `error`, `spawn`.

**Deduplication strategy:** Since `exec` → `execFile` → `spawn` internally, patching all four would create duplicate events. Two options:

- Use a `Symbol` marker on options to track the highest-level entry point, skip reporting at lower levels
- Use a `WeakSet` to track already-reported `ChildProcess` instances

**Sync variants** need separate wrappers — they return result objects, not `ChildProcess` instances.

**Self-instrumentation:** The SDK itself uses `execFile('sw_vers')` in `src/transport/userAgent.ts`. Must filter out internal calls.

### Bundler impact

**Safe.** All bundlers (Webpack, Vite, esbuild) externalize `child_process` when targeting Electron main process. The `require()` cache ensures all consumers get the patched version. Both `child_process` and `node:child_process` resolve to the same module.

The patch must happen early (before any customer code calls `require('child_process')`), achievable since the SDK initializes at app startup.

### Instrumentation overhead

**Negligible.** Process creation is an OS-level operation (5-50ms). The wrapper adds microseconds (function call + event listener registration + timestamp). Even for high-frequency spawners like VS Code (hundreds of git commands per session), unmeasurable.

### Data flow back to main process

**Trivial.** The parent IS the main process. All events (`exit`, `error`) fire in the main process event loop. Data feeds directly into the SDK's event pipeline.

### Risks / unknowns — what prototyping would answer

- **Argument normalization** — All methods have overloaded signatures (args optional, options optional, callback optional). Need robust normalizer.
- **`util.promisify` compatibility** — Wrapping `exec`/`execFile` must preserve the `[util.promisify.custom]` symbol. Needs validation.
- **Sensitive data in args** — Commands may contain tokens, passwords, API keys. Need scrubbing strategy.
- **High-frequency spawners** — Telemetry volume from apps like VS Code. Need sampling/aggregation strategy.
- **Detached processes** — `options.detached` + `child.unref()` means the child outlives the parent. `exit` event may never fire.
- **Double-counting** — Validate the deduplication approach across the exec → spawn call chain.

---

## 2. Electron Lifecycle Events

### What it is

Electron framework events that fire when child processes terminate, plus a polling API for process metrics.

- **`app.on('child-process-gone')`** — Fires when a non-renderer child process disappears. Provides: `type` (Utility, GPU, Zygote, etc.), `reason` (clean-exit, abnormal-exit, killed, crashed, oom, launch-failed, integrity-failure, memory-eviction), `exitCode`, `serviceName`, `name`.
- **`app.on('render-process-gone')`** — Fires when a renderer crashes. Provides: `reason`, `exitCode`, plus the associated `WebContents` for window correlation.
- **`app.getAppMetrics()`** — Returns `ProcessMetric[]` with: `pid`, `type` (Browser, Tab, Utility, GPU, etc.), `cpu` (percentCPUUsage, idleWakeupsPerSecond, cumulativeCPUUsage), `memory` (workingSetSize, peakWorkingSetSize), `creationTime`, `serviceName`, `sandboxed`, `integrityLevel` (Windows).

### Customer use cases

These are framework events, not customer-initiated. They track ALL Electron child processes (renderers, GPU, utility, service workers). Major apps show crash recovery UI and log crashes.

### Customer likelihood

**Universal.** Every Electron app has these processes. Crashes are infrequent in stable apps but each one is a significant user-impacting event. OOM is the most common production crash reason.

### Monitoring value

**Exit reason to RUM event type mapping:**

| Reason              | Suggested RUM Type                                |
| ------------------- | ------------------------------------------------- |
| `clean-exit`        | Action (lifecycle) — may want to filter for noise |
| `abnormal-exit`     | Error                                             |
| `killed`            | Error                                             |
| `crashed`           | Error                                             |
| `oom`               | Error — high-value signal                         |
| `launch-failed`     | Error                                             |
| `integrity-failure` | Error (Windows)                                   |
| `memory-eviction`   | Error                                             |

**Metrics:** CPU% per process type (detect runaway renderers), memory per process (detect leaks approaching OOM), process count (detect proliferation), creation time (detect crash loops via frequent restarts).

### Instrumentation approach

**Trivial.** Simple event listeners on `app`, no monkey-patching:

```
app.on('child-process-gone', ...)
app.on('render-process-gone', ...)
setInterval(() => app.getAppMetrics(), POLL_INTERVAL)
```

Fits cleanly into the existing `EventManager` handler pattern.

### Bundler impact

**None.** `require('electron')` is universally externalized by all Electron bundlers.

### Instrumentation overhead

**Negligible.** Event listeners: zero cost (fire only on termination). `getAppMetrics()` polling: synchronous call, microseconds, proportional to process count (typically 5-15). Even at 1-second interval, very low.

### Data flow back to main process

**Ideal.** Both events fire in the main process where the SDK lives. `getAppMetrics()` is a main-process API. No cross-process communication needed.

### Risks / unknowns

- **`clean-exit` noise** — `child-process-gone` fires for clean exits too. Utility processes routinely cycled may generate low-value events. May need filtering.
- **`getAppMetrics()` CPU quirk** — `percentCPUUsage` returns 0 on first call, measures since last call. SDK must call at least twice; measurement window = poll interval.
- **No `child-process-spawned` event** — No event for process start. Detect new processes by diffing `getAppMetrics()` snapshots using `pid` + `creationTime` as unique key.
- **`MemoryInfo` limitations** — `privateBytes` is Windows-only. No per-process JS heap size (V8 heap stats only available in-process).

---

## 3. Electron utilityProcess

### What it is

Electron API (since v22) for spawning **sandboxed Node.js child processes** from the main process. Alternative to `child_process.fork` designed for Electron.

`utilityProcess.fork(modulePath, args?, options?)` — returns a `UtilityProcess` instance. Key options: `serviceName` (appears in `getAppMetrics` and `child-process-gone`), `env`, `execArgv`, `cwd`, `stdio`, `allowLoadingUnsignedLibraries` (macOS).

**vs child_process.fork:**

| Aspect          | child_process.fork             | utilityProcess.fork                  |
| --------------- | ------------------------------ | ------------------------------------ |
| Binary          | Full Electron (~150MB)         | Lightweight Node.js context          |
| IPC             | Node.js channel (process.send) | MessagePort (parentPort.postMessage) |
| Crash reporting | Not integrated                 | Integrated (child-process-gone)      |
| Metrics         | Not in getAppMetrics           | Visible in getAppMetrics             |
| Sandboxing      | None                           | Chromium sandbox                     |

Inside the utility process: `process.parentPort` for communication with main. Has `postMessage` and `on('message')`.

### Customer use cases

- **VS Code** — Extension host, language servers, file watcher, search — all migrated from `child_process.fork` to `utilityProcess`.
- **Generic patterns** — Native addon isolation (crash doesn't kill main), background network requests (Electron `net` module available), heavy computation, plugin systems.

### Customer likelihood

**High and growing rapidly (~30-40%).** Electron docs recommend it over `child_process.fork`. VS Code's adoption is a strong ecosystem signal. New Electron apps almost certainly use it for background processing.

### Monitoring value

**High.** Most telemetry is available from main-process APIs without instrumenting the child:

- `serviceName` identifies each utility process's purpose
- `app.getAppMetrics()` provides CPU/memory per process
- `child-process-gone` provides crash reasons
- `error` event provides V8 fatal errors with diagnostic reports
- Fork wrapper captures: modulePath, creation/exit times, exit codes, message counts

### Instrumentation approach

Wrap `utilityProcess.fork()` — it's a static method on a singleton, single patch point. The returned `UtilityProcess` is an EventEmitter — standard event listening for `spawn`, `exit`, `message`, `error`.

**Main-process-only approach (recommended first):** Fork wrapping + `getAppMetrics()` polling + `child-process-gone` listener. Captures ~80% of value with near-zero complexity.

**Child-side instrumentation (later):** Inject via `execArgv` with `--require` or transfer a dedicated `MessagePortMain` for a telemetry channel.

### Bundler impact

**Low risk.** `require('electron')` is always external. The monkey-patch intercepts the call before module path resolution. For child-side injection via `--require`, the required file must exist on disk (not inside a bundle) — the SDK ships as a node_modules file, so this works.

Electron Forge (Webpack), electron-vite, and electron-builder all support utility process entry points as separate entries.

### Instrumentation overhead

**Very low.** Fork wrapping: negligible (process creation takes 50-200ms). `getAppMetrics()` polling: <1ms per call. Event listeners: zero cost. Message counting: optional, count-only is cheap.

### Data flow back to main process

**Excellent.** Three layers of data available without any child instrumentation:

1. `child-process-gone` event — crash reasons, exit codes
2. `app.getAppMetrics()` — CPU, memory, process type, service name
3. Fork wrapper — creation time, module path, message count

For richer child-side telemetry: `MessagePortMain` (dedicated channel) or `parentPort.postMessage` (piggyback on existing channel).

### Risks / unknowns

- **`serviceName` uniqueness** — If app doesn't set it, all utility processes appear as "Node Utility Process". Need fallback identification (modulePath, PID).
- **`execArgv` injection safety** — Adding `--require` must not break the utility process's own flags (`--inspect`, `--max-old-space-size`).
- **Crash report correlation** — When a utility process crashes, unsent telemetry from that process is lost. Main-process-only approach avoids this issue.
- **Multiple concurrent utility processes** — Apps like VS Code spawn many. SDK must handle tens of concurrent processes efficiently.

---

## 4. child_process.fork

### What it is

Specialized `spawn` for creating Node.js child processes with built-in IPC. `fork(modulePath, args?, options?)` spawns a new Node.js instance running the specified module. Always creates an IPC channel (`child.send()` / `child.on('message')`).

Key detail in Electron: `fork()` uses the Electron binary as the Node.js runtime by default (since `process.execPath` = Electron). The forked process is a full Electron process. Developers often set `options.execPath` to a standalone `node` binary, or use `utilityProcess` instead.

### Customer use cases

- **CPU-intensive offloading** — Image processing, data transformation, encryption.
- **VS Code (legacy)** — Extension host was originally a forked process (migrated to utilityProcess).
- **Worker-like patterns** — Before `worker_threads` was stable, fork was the standard for parallel computation.
- **Build tools** — Running webpack, TypeScript compiler as separate processes.

### Customer likelihood

**Medium and declining.** `worker_threads` and `utilityProcess` are replacing fork use cases. Still significant in legacy apps and frameworks that predate Electron 22.

### Monitoring value

Same as spawn, plus:

- IPC message count/volume — communication overhead
- `modulePath` — which JS module is the child
- Whether `execPath` overrides Electron — full Electron process vs lightweight node
- `execArgv` — memory limits, debug flags

### Instrumentation approach

Same monkey-patching pattern as spawn. Additionally can count IPC messages via `child.on('message')`. No double-counting concern with spawn — can detect fork-originated processes by the `'ipc'` in `options.stdio`.

**Data flow options:**

- **Parent-side only (recommended):** Instrument the fork wrapper, capture modulePath, duration, exit code, IPC message count. No child modification needed.
- **IPC-based child telemetry (later):** Inject `--require` preload via `execArgv`. Child reports memory, errors, custom metrics via `process.send()`. Parent filters out DD-internal messages.

### Bundler impact

Same as spawn — `child_process` is externalized. Additional note: the `modulePath` argument is a file path that must exist at runtime. If the app is bundled, the worker script may not be in the expected location — but this is the developer's problem, not ours.

### Instrumentation overhead

**Negligible.** Fork creates a full Node.js process (50-200ms startup). Wrapper cost immeasurable.

**IPC message counting risk:** For high-frequency IPC (e.g., language servers sending hundreds of messages/sec), listening on every `message` event could add measurable overhead. Needs benchmarking.

### Risks / unknowns

- **IPC message counting overhead** — Benchmark for high-frequency forked processes.
- **Process trees** — Fork can create nested trees (A forks B, B forks C). Monitoring depth is a concern.
- **fork + custom execPath** — When set to standalone `node`, child preload injection must work in both Electron and plain Node contexts.
- **Zombie processes** — If IPC channel breaks (parent crashes), children become orphans.

---

## 5. worker_threads

### What it is

Node.js API for in-process parallelism via OS threads. Each worker has a separate V8 context but shares the same OS process. Key APIs: `new Worker(filename, options)`, `parentPort`, `workerData`, `MessageChannel`, `SharedArrayBuffer`.

Workers can set `resourceLimits` (maxOldGenerationSizeMb, maxYoungGenerationSizeMb, stackSizeMb). Workers have their own event loop.

### Customer use cases

- **CPU-intensive computation** — Image processing, data transformation, search indexing, compression (fflate), encryption.
- **Library-internal usage** — Many npm packages use workers internally (esbuild, synckit, eslint, vitest). Apps may transitively use them without explicit intent.
- **Native addon isolation** — Partial — a segfault still kills the whole process.

### Customer likelihood

**Moderate (~20-30%).** Common in libraries/build tooling, less common as direct API usage in Electron main processes. Most Electron developers prefer process-level isolation (`utilityProcess` or `fork`).

### Monitoring value

| Data                        | Value                                           |
| --------------------------- | ----------------------------------------------- |
| Worker creation/termination | High — lifecycle, detect leaks                  |
| Exit codes + error events   | High — uncaught exceptions                      |
| Worker script path          | High — identify workers                         |
| CPU time per worker         | Medium — `worker.cpuUsage()` available natively |
| Memory/heap stats           | Medium — `worker.getHeapStatistics()` available |
| Message count/size          | Medium — detect chatty workers                  |
| Thread count over time      | Medium — detect pool exhaustion                 |

### Instrumentation approach

**Constructor patching:** Replace `Worker` on the `worker_threads` module with an instrumented subclass or wrapper. Straightforward since the module is a singleton with a reassignable `Worker` property.

**Child-side injection is the hard part:** The worker script is opaque. Options:

- `execArgv` with `--require` — loads instrumentation before the worker script. Needs validation.
- `workerData` — pass config, worker voluntarily imports SDK. Not transparent.
- Dedicated `MessageChannel` — transfer a port via `workerData` for telemetry.

### Bundler impact

**Medium concern.** Constructor patching is safe (module is externalized). But worker scripts need separate bundling — Webpack 5 has patterns for this, esbuild does not auto-handle it. Inline workers (`eval: true`) bypass file issues but are rare.

### Instrumentation overhead

Worker creation wrapping: negligible (~50-100ms for V8 context setup, wrapper adds microseconds). Message interception is the concern — workers can send thousands of messages/sec. Count-only mode (~1μs/message) is safe. Full size measurement could double serialization time.

### Data flow back to main process

Good options: `parentPort` (built-in), dedicated `MessageChannel` (recommended), `SharedArrayBuffer` (zero-copy for numeric data, complex to implement), `BroadcastChannel` (simple, less controlled).

### Risks / unknowns

- **Child-side injection** — `--require` via `execArgv` needs prototyping.
- **`SharedArrayBuffer` interception** — Not feasible (direct memory access).
- **Worker pools** (`piscina`, `workerpool`) — Instrumentation must correctly attribute work across pooled workers.
- **`eval: true` inline workers** — Cannot inject instrumentation.
- **Native addon workers** — Must not interfere with addon loading.

---

## 6. MessagePort / MessageChannel

### What it is

Electron's cross-process communication primitives. `MessageChannelMain` (main process only) creates paired `MessagePortMain` objects. Ports transfer across process boundaries via `webContents.postMessage()` or `utilityProcess.postMessage()`.

Key differences from Web/Node.js: `MessagePortMain` uses Node's EventEmitter API, exists only in main process. Renderers use standard web `MessagePort`.

### Customer use cases

- **VS Code** — Primary IPC for extension host (utility process), SharedProcess, service workers.
- **Utility process communication** — MessagePort is the primary way to establish channels with utility processes (no `ipcMain`/`ipcRenderer` equivalent).
- Most apps using only renderers + main still prefer `ipcMain`/`ipcRenderer` (simpler, channel-name routing).

### Customer likelihood

**Growing (~15-25%).** Tied to utility process adoption. Apps with complex multi-process architectures use it.

### Monitoring value

**Low as standalone telemetry.** IPC messages are implementation details — volume/size metrics are niche. **High as SDK transport mechanism** for getting telemetry from utility/renderer processes back to main.

### Instrumentation approach

**As monitoring target (not recommended):** Patch `MessagePortMain.prototype.postMessage`. Risky — it's a C++ binding. Ports are anonymous (no channel names for identification). High overhead on hot paths.

**As SDK transport (recommended use):** Create a dedicated `MessageChannelMain` per child process, transfer one port to the child. Clean, no interference with app messages.

### Bundler impact

**None.** Runtime APIs, not module imports.

### Instrumentation overhead

**High risk as monitoring target** — VS Code extension host can send thousands of messages/sec. **Negligible as SDK transport** — SDK telemetry volume is low.

### Risks / unknowns

- Prototype patching reliability on native bindings needs validation
- Port lifecycle management (renderer crash destroys ports, need reconnection)
- No ordering guarantees if process crashes mid-send

---

## Cross-Cutting Concerns

### Deduplication

Internal call chain: `exec` → `execFile` → `spawn`. Patching all creates duplicates. Recommended: use a `Symbol` marker on options to track the entry point, skip lower-level reporting.

### Sensitive data scrubbing

Commands/args may contain tokens, passwords, API keys. Need: pattern-based scrubbing (URLs with credentials, `--password`/`--token` flags), customer-configurable rules.

### Telemetry volume / sampling

High-frequency spawners (VS Code) need: rate sampling, command-based filtering, aggregation (group by command, report counts + avg duration).

### Self-instrumentation filtering

SDK uses `execFile('sw_vers')` internally. Must exclude from customer telemetry.

### Relationship to SDK architecture

Child process events fit as a new `RawEvent` source flowing through `EventManager` → `Assembly` → `Transport`. Events tagged with `EventSource.MAIN`. Could add `EventSource.CHILD_PROCESS` for events originating from child-side instrumentation.
