# Child Process Monitoring — Prototype Findings

Results from hands-on prototyping of child process instrumentation approaches.

See `prototype-child-processes_00_research.md` for the landscape survey.

---

## Prototype 1: child_process.spawn/exec/execFile

**Branch:** `bcaudan/proto-spawn`
**Status:** Not started

### Findings

_To be populated after prototype._

### What worked

### What didn't

### Unexpected issues

### Feasibility verdict

---

## Prototype 2: Electron lifecycle events

**Branch:** `bcaudan/proto-lifecycle`
**Status:** Complete

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
**Status:** Not started

### Findings

_To be populated after prototype._

### What worked

### What didn't

### Unexpected issues

### Feasibility verdict
