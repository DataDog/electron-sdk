# Child Process Monitoring — RUM Concept Mapping

How child process telemetry maps to RUM events. Based on prototype findings (`_01_prototypes.md`), RUM schema analysis (`rum-events-format`), and product brief alignment.

---

## Foundation: Processes as Views

Every Electron process becomes a **RUM View**. This provides:

- A `view.id` to correlate all events from that process
- Built-in `memory_average`, `memory_max`, `cpu_ticks_per_second` fields (existing mobile schema in `_view-properties-schema.json`)
- Built-in `error.count`, `resource.count`, `action.count` counters
- `container` hierarchy for renderer → page view nesting (already implemented in `Assembly.ts`)

View naming: `"{ProcessType}: {serviceName}"` (e.g., "Utility: dd-proto-worker", "Renderer: webContentsId=1", "GPU")

### Container Hierarchy

```
Session
├── Main process view (source=electron)        ← already exists
├── GPU process view (source=electron)
├── Utility process view (source=electron)
│   └── errors, resources attached to this view
├── Renderer process view (source=electron)
│   └── container for:
│       └── Page view (source=browser, container.view.id → renderer view)
│           └── browser-rum events
```

The `container` mechanism is already in place — `Assembly.ts` sets `container.view.id` on renderer events. The `_view-container-schema.json` already lists `"electron"` as a valid `container.source`. For renderer processes, we extend the existing mechanism so browser-rum events point to their **renderer process view**.

---

## Datapoint Mapping

### Utility Process Monitoring

| Datapoint                                 | RUM Event                 | Fields                                                  | Notes                                |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------- | ------------------------------------ |
| `utilityProcess.fork()`                   | **View start**            | `view.name`: "Utility: {serviceName}"                   | New view per process                 |
| Utility spawn                             | **View update**           | context: pid, creationTime                              | Process identity                     |
| Utility exit (code=0)                     | **View end** + **Action** | `action.type`: custom, `target.name`: "process_exit"    | Product brief: clean-exit → Action   |
| Utility exit (code≠0)                     | **View end** + **Error**  | `error.source`: "source", `error.handling`: "unhandled" | Product brief: abnormal-exit → Error |
| `child-process-gone` (crashed/oom/killed) | **Error** on process view | `error.is_crash`: true, context: reason, exitCode       | Enriches with crash reason           |
| Error forwarded via parentPort            | **Error** on process view | `error.message`, `error.stack`, `error.type`            | Full stack trace available           |
| Metrics (getAppMetrics)                   | **View update**           | `memory_average`, `memory_max`, `cpu_ticks_per_second`  | Periodic polling                     |

**Event lifecycle:**

1. `fork()` → create view, record start time
2. `spawn` event → record pid
3. `exit` event → record exitCode, duration
4. `child-process-gone` (if abnormal) → enrich with crash reason
5. Emit view end + error/action

### spawn/exec as Resource

| Datapoint               | RUM Event             | Fields                                               | Notes                                 |
| ----------------------- | --------------------- | ---------------------------------------------------- | ------------------------------------- |
| `spawn/exec/execFile`   | **Resource**          | `type`: "native", `url`: "child_process://{command}" | Mirrors network resource/span duality |
| Exit code               | Resource              | `status_code`: exit code                             | 0=success, nonzero=failure            |
| Duration                | Resource              | `duration`: spawn→exit time                          |                                       |
| Error (ENOENT, timeout) | Resource (same event) | `status_code`: -1, context: error details            | **No separate Error event**           |
| Command args            | Resource context      | context: args, shell, cwd                            | Temporary; needs schema extension     |
| Sync variants           | Resource              | Same mapping                                         |                                       |

**Key design decisions:**

- Errors on spawn/exec do NOT produce separate Error events. All error info lives on the Resource itself (like failed HTTP requests).
- `child-process-gone` does NOT fire for Node.js child_process spawns (validated in proto-lifecycle).
- The product brief positions spawn/exec as APM `command_execution` spans. The RUM Resource mirrors the APM span, following the same pattern as network requests (RUM Resource + APM client span).

**Resource event lifecycle:**

1. Wrapper intercepts spawn/exec call → record start time
2. `exit` event → emit Resource with duration + status_code
3. `error` event → emit Resource with error info in context

### Renderer Process Monitoring

| Datapoint                                  | RUM Event                  | Fields                                                              |
| ------------------------------------------ | -------------------------- | ------------------------------------------------------------------- |
| Renderer creation (via getAppMetrics diff) | **View start**             | `view.name`: "Renderer: {webContentsId}"                            |
| `render-process-gone`                      | **Error** on renderer view | `error.is_crash`: true, context: reason, exitCode                   |
| Browser-rum page views                     | **View** (child)           | `container.view.id` → renderer view, `container.source`: "electron" |
| Renderer metrics                           | **View update**            | `memory_average`, `cpu_ticks_per_second`                            |

### Performance Metrics

Attached to process views as periodic view updates (like mobile SDKs).

| getAppMetrics field   | View field                      | Notes                               |
| --------------------- | ------------------------------- | ----------------------------------- |
| `workingSetSize`      | `memory_average` / `memory_max` | Running average + peak              |
| `percentCPUUsage`     | `cpu_ticks_per_second`          | Unit conversion needed (% vs ticks) |
| Process count changes | Main view context               | Detect appeared/disappeared         |

---

## Schema Fit Assessment

| Mapping                           | Fit           | Production Requirement                                                |
| --------------------------------- | ------------- | --------------------------------------------------------------------- |
| Processes as Views                | **Excellent** | No schema change                                                      |
| Container hierarchy               | **Excellent** | Already implemented                                                   |
| child-process-gone → Error/Action | **Good**      | Need schema field for `reason` (not context)                          |
| Utility errors → Error            | **Excellent** | No change                                                             |
| spawn/exec → Resource (native)    | **Moderate**  | Need `resource.process` sub-object (command, args, exit_code, signal) |
| Metrics → View fields             | **Good**      | CPU unit alignment (% vs ticks)                                       |

**Important:** `context` attributes are customer-owned in production. For the prototype, we use context for process-specific data (reason, args, pid). For production, these need schema extensions in `rum-events-format`:

- `resource.process` — command, args, exit_code, signal
- `error.process` — type, service_name, reason
- View-level process identity fields

---

## Product Brief Alignment

| Brief Recommendation                     | Our Mapping                            | Delta                                                     |
| ---------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| child-process-gone (clean-exit) → Action | Action                                 | Aligned                                                   |
| child-process-gone (abnormal) → Error    | Error                                  | Aligned                                                   |
| spawn/exec → APM command_execution spans | Resource (native) for RUM side         | Brief says APM; we add RUM mirror (resource/span duality) |
| Metrics → mini-timeseries on session     | View-level aggregates (mobile pattern) | Different mechanism, same data                            |
