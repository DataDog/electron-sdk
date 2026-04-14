# Child Process Monitoring — Prototype Findings

Results from hands-on prototyping of child process instrumentation approaches.

See `prototype-child-processes_00_research.md` for the landscape survey.

---

## Prototype 1: child_process.spawn/exec/execFile

**Branch:** `bcaudan/proto-spawn`
**Status:** Complete

### Instrumentation strategy

Monkey-patch `spawn`, `exec`, `execFile` (and sync variants) on the `child_process` module object at SDK initialization time, before any customer code runs.

```
SDK init (early)
  └─ instrumentChildProcess()
       ├─ require('node:child_process')  ← must use require(), not import *
       ├─ Object.defineProperty(cp, 'spawn', wrappedSpawn)
       ├─ Object.defineProperty(cp, 'exec', wrappedExec)
       ├─ Object.defineProperty(cp, 'execFile', wrappedExecFile)
       └─ (same for sync variants)

Customer code calls child_process.spawn/exec/execFile
  └─ Our wrapper intercepts
       ├─ Records: command, args, start time
       ├─ Calls original function
       ├─ Listens for exit/error events (async) or wraps callback (exec/execFile)
       └─ Logs telemetry to main process: command, args, duration, exitCode/error
```

All data stays in the main process — no cross-process communication needed since the parent IS the main process.

### Findings

| Test                              | Result                                                               |
| --------------------------------- | -------------------------------------------------------------------- |
| `spawn('ls', ['-la'])`            | Captured: command, args, duration (22ms), exitCode=0                 |
| `exec('echo hello world')`        | Captured: command, duration (8ms), stdoutSize, stderrSize            |
| `execFile('node', ['--version'])` | Captured: command, args, duration (247ms), exitCode=0                |
| `spawn('nonexistent')`            | Error captured: ENOENT                                               |
| `exec('sleep 10', {timeout:100})` | Timeout captured: killed=true, signal=SIGTERM                        |
| `util.promisify(exec)`            | Works after symbol copying fix                                       |
| `spawnSync('ls')`                 | Captured: exitCode=0, duration (5ms)                                 |
| SDK self-instrumentation          | `execFile('sw_vers')` from `userAgent.ts` captured — needs filtering |

### What worked

- **`Object.defineProperty` on the real module object** — `require('node:child_process')` returns a module with `writable:true, configurable:true` properties. Patching via `Object.defineProperty` works reliably.
- **All async and sync variants captured** — spawn, exec, execFile, spawnSync, execSync, execFileSync all successfully instrumented.
- **Symbol copying preserves `util.promisify`** — copying `[util.promisify.custom]` from original to wrapper makes promisified exec work.
- **Error cases captured** — ENOENT (missing binary), timeout kills, both properly logged.

### What didn't

- **`import * as child_process` is NOT patchable** — TypeScript's `__importStar` helper creates a wrapper object with **non-configurable getter-only** properties. Both direct assignment and `Object.defineProperty` fail. Must use `require()` to get the real module.
- **`diagnostics_channel` for child_process does NOT exist** in Node.js v22.21.1 (Electron 39). Only `http`, `net`, and `undici` have tracing channels. Not a viable alternative currently.
- **Deduplication is unsolvable at the public API level** — `exec` calls `execFile` internally (not `spawn`). Patching both produces duplicate events. The internal chain `exec` → `execFile` → internal spawn bypasses the public `spawn`. Options: (a) accept duplicates, (b) only patch `exec` and `spawn` (miss direct `execFile` calls), (c) use a marker/WeakSet for dedup.
- **`util.promisify(exec)` bypasses the exec wrapper** — The `[util.promisify.custom]` function on `exec` calls `execFile` directly. So promisified exec produces an `execFile` log, not an `exec` log.

### Unexpected issues

- **`__importStar` is the #1 monkey-patching hazard for Electron** — any TypeScript/bundler that wraps `import *` into a frozen namespace object will break patching. This affects all built-in module patching, not just child_process.
- **Alternative approaches available if monkey-patching proves insufficient:** `shimmer` (dd-trace's approach), `require-in-the-middle` (RITM), `import-in-the-middle` (IITM). Documented for future reference.
- **`execFile` is the internal workhorse** — both `exec` and `util.promisify(exec)` route through `execFile`. If we could only patch one method, `execFile` gives the broadest coverage (catches exec, execFile, and promisified exec). `spawn` must be patched separately.
- **SDK self-instrumentation** — the SDK's own `execFile('sw_vers')` in `userAgent.ts` is captured. Production implementation needs a filtering mechanism.

### Open questions for production

- **Bundler behavior untested** — the prototype uses tsc (no bundling for main process). When the app is bundled with Webpack/esbuild/Vite, bundlers may handle `require('node:child_process')` differently. Need to verify patching works in bundled apps.
- **Best monkey-patching approach** — for production, evaluate `shimmer`, `require-in-the-middle` (RITM), or `import-in-the-middle` (IITM) instead of manual `Object.defineProperty`. The `__importStar` constraint must be accounted for in any approach — this is a cross-cutting concern for all built-in module instrumentation.
- **`diagnostics_channel` for `child_process`** — does not exist in Node 22 but may be added in future versions. Monitor Node.js releases; this would be the cleanest long-term approach.

### Feasibility verdict

**Feasible with caveats.** Monkey-patching works but requires `require()` (not `import *`) and `Object.defineProperty`. Deduplication across the exec→execFile chain needs a design decision. For production implementation, the monkey-patching approach should be evaluated carefully — consider using `shimmer` or `require-in-the-middle` for robustness, and test with all major bundler configurations (Webpack, esbuild, Vite).

---

## Prototype 2: Electron lifecycle events

**Branch:** `bcaudan/proto-lifecycle`
**Status:** Complete

### Instrumentation strategy

Subscribe to Electron's built-in process lifecycle events and poll `app.getAppMetrics()` on a timer. No monkey-patching needed — pure event listeners.

```
SDK init (after app.whenReady)
  └─ setupLifecycleMonitoring()
       ├─ app.on('child-process-gone')     ← Electron-managed processes only (GPU, utility, etc.)
       ├─ app.on('render-process-gone')    ← renderer crashes, with webContentsId for correlation
       └─ setInterval(5s)
            └─ app.getAppMetrics()         ← CPU%, memory per process
                 └─ Diff snapshots by pid+creationTime → detect appeared/disappeared processes
```

All data originates in the main process. Lifecycle events provide crash reasons (clean-exit, abnormal-exit, killed, crashed, oom). Metrics polling provides continuous CPU/memory per process type.

### Findings

| Test                                                   | Result                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `app.getAppMetrics()` polling                          | Works. Returns CPU%, memory (workingSetSize, peakWorkingSetSize), process type, serviceName, pid, creationTime.                      |
| Process discovery via snapshot diff                    | Works. Detects appeared/disappeared processes by diffing `pid+creationTime` between polls.                                           |
| `render-process-gone` on crash                         | Works. Provides `reason=killed`, `exitCode=2`, `webContentsId` for correlation.                                                      |
| `render-process-gone` on normal close                  | **Does NOT fire.** Cmd+W window close produces no event — only abnormal terminations trigger it.                                     |
| `child-process-gone` for Node.js `child_process.spawn` | **Does NOT fire.** Only Electron-managed processes (GPU, utility, renderers) trigger this event.                                     |
| CPU% quirk (first call returns 0)                      | Confirmed. First `getAppMetrics()` call returns `percentCPUUsage=0.0%` for all processes. Meaningful values from second call onward. |
| Default Electron process tree                          | 4 processes at startup: Browser (main), GPU, Utility (network.mojom.NetworkService), Tab (renderer).                                 |

### What worked

- Simple event listeners — no monkey-patching needed, trivially integrates with existing SDK `EventManager` pattern
- `getAppMetrics()` provides rich data without any child process instrumentation (CPU, memory, process type, serviceName)
- Process discovery via snapshot diffing is reliable — `pid+creationTime` is a unique stable key
- `render-process-gone` provides `webContentsId` for correlating crashes to specific windows/views

### What didn't

- `child-process-gone` does not cover Node.js `child_process` — separate instrumentation (proto-spawn) is needed for those
- Crashing the main process (`process.crash()`) kills the observer — no events captured. Main process crashes must be detected via crash dumps at next startup (existing `CrashCollection`).

### Unexpected issues

- Electron already runs a `Utility` process by default (network service, `serviceName=network.mojom.NetworkService`). `getAppMetrics()` will always show at least one utility process even without customer code spawning any.
- `render-process-gone` with `reason=killed` (not `crashed`) when using `forcefullyCrashRenderer()`. The `reason` field values may not always match intuition.
- Normal window close does NOT trigger `render-process-gone` — every event from this listener is genuinely abnormal. No filtering needed.

### Feasibility verdict

**Fully feasible. Trivial to implement.** Zero risk, zero overhead, high value. Should be included in the SDK immediately — it's the lowest-hanging fruit of all mechanisms surveyed.

---

## Prototype 3: Electron utilityProcess

**Branch:** `bcaudan/proto-utility`
**Status:** Complete

### Instrumentation strategy

Two layers: (1) monkey-patch `utilityProcess.fork()` in the main process, and (2) establish a dedicated telemetry channel to the utility process for rich data.

```
SDK init (early)
  └─ instrumentUtilityProcess()
       ├─ Object.defineProperty(utilityProcess, 'fork', wrappedFork)
       └─ app.on('child-process-gone')    ← catches utility process crashes

Customer code calls utilityProcess.fork(modulePath, args, options)
  └─ Our wrapper intercepts
       ├─ Records: modulePath, serviceName, start time
       ├─ Calls original fork → returns UtilityProcess instance
       ├─ Wraps child.postMessage() → counts outbound messages
       ├─ Listens for spawn, message, exit, error events → counts inbound, logs telemetry
       └─ (optional) Sets up dedicated MessagePort telemetry channel:
            Main process                          Utility process
            ┌─────────────────┐                   ┌──────────────────┐
            │ port1.on('msg') │◄──── MessagePort ──│ port2.postMessage│
            │ (receives       │      (dedicated    │ (sends periodic  │
            │  telemetry)     │       channel)     │  memory/CPU)     │
            └─────────────────┘                   └──────────────────┘

Error forwarding (parentPort piggyback):
  Utility process catches uncaughtException
    └─ parentPort.postMessage({ __dd: true, type: 'error', data: { message, stack } })
         └─ Main process filters __dd messages from app messages, logs error with stack trace
```

Data flows back to main process via three complementary paths:

- **`child-process-gone` event** — automatic, provides crash reason (but no error details)
- **parentPort `__dd` messages** — error details with stack traces, arrives before child-process-gone. **Caveat:** `__dd` messages leak into the customer's `child.on('message')` handlers — we can't suppress them since EventEmitter delivers to all listeners. Suitable for one-shot critical data (crash-time error forwarding) but not for periodic telemetry.
- **Dedicated MessagePort** — rich periodic telemetry (memory, CPU), completely separate from app traffic. Invisible to the customer. **Recommended for all ongoing telemetry.**

### Findings

| Test                                    | Result                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `utilityProcess.fork()` monkey-patching | Works via `Object.defineProperty` on the `utilityProcess` singleton                                                                           |
| Fork with serviceName                   | Captured: modulePath, serviceName, pid on spawn                                                                                               |
| Send ping (round-trip)                  | Works. Message in/out both tracked with counts                                                                                                |
| Send work (fibonacci 35)                | 63ms computation in utility process, result received in main                                                                                  |
| Dedicated MessagePort channel           | Works. Periodic telemetry (memoryUsage, cpuUsage) every 2s on dedicated port                                                                  |
| parentPort piggyback (`__dd` prefix)    | Works. Error forwarding with full stack trace received in main. Filtered from app messages.                                                   |
| Crash utility (thrown error)            | Three events in order: (1) `dd-message` with stack trace, (2) `utilityProcess.exit` exitCode=1, (3) `child-process-gone` reason=abnormal-exit |
| Exit utility (process.exit(1))          | `utilityProcess.exit` exitCode=1 + `child-process-gone` reason=abnormal-exit. **No** error message forwarded.                                 |
| `child-process-gone` correlation        | Fires with `type=Utility`, `serviceName=node.mojom.NodeService`, `name=dd-proto-worker`                                                       |
| Fork without serviceName                | Appears as `service=Node Utility Process` — hard to identify                                                                                  |

### What worked

- **Fork wrapper via `Object.defineProperty`** — `utilityProcess.fork` is a static method on a singleton. Straightforward and reliable.
- **All 3 data flow approaches validated:**
  - **Dedicated MessagePort channel** — richest. Periodic telemetry (memory, CPU) on a separate port. No interference with app messages.
  - **parentPort piggyback (`__dd` prefix)** — simpler setup. Error forwarding with full stack traces. `__dd` flag cleanly separates SDK from app messages.
  - **`child-process-gone` event** — fires automatically for all utility process terminations. Provides reason, exitCode, serviceName.
- **Crash error ordering is reliable** — error message via parentPort arrives **before** `child-process-gone`. Allows correlating error details with lifecycle event.
- **`getAppMetrics()` provides free metrics** — CPU%, memory per utility process, keyed by serviceName. No child-side instrumentation needed.

### What didn't

- **`child-process-gone` cannot distinguish crash from intentional exit** — both `process.exit(1)` and thrown errors produce `reason=abnormal-exit, exitCode=256`. Only differentiator is whether an error message was forwarded via parentPort.
- **`child-process-gone` serviceName is Chromium-internal** — shows `node.mojom.NodeService`, not the user's serviceName. The `name` field has the user-set value. Different fields for different identifiers.
- **`child-process-gone` exitCode differs from utility exit event** — Chromium reports `exitCode=256` for `process.exit(1)`, while the utility `exit` event correctly reports `exitCode=1`.
- **parentPort piggyback leaks into customer message handlers** — `__dd`-prefixed messages are visible to the customer's `child.on('message')` listeners. EventEmitter delivers to all listeners; we cannot suppress delivery. This makes parentPort piggyback unsuitable for periodic telemetry (pollutes customer IPC). Use only for one-shot critical data (crash-time error forwarding where the process is dying anyway). Use the dedicated MessagePort channel for all ongoing telemetry.

### Unexpected issues

- Fork without serviceName defaults to `Node Utility Process` — multiple unnamed utility processes would be indistinguishable. SDK guidance should recommend always setting serviceName.
- Electron always runs a `network.mojom.NetworkService` utility process. `getAppMetrics()` always shows at least one Utility type.

### Feasibility verdict

**Fully feasible. High value, low complexity.** Main-process-only approach (fork wrapper + `getAppMetrics()` + `child-process-gone`) captures ~80% of useful telemetry with near-zero overhead. Dedicated MessagePort channel provides rich child-side telemetry when deeper visibility is needed.
