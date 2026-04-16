# Child Process Monitoring — Demo Scenario

Live demo script. Covers the goal, approach, prototype walkthrough, and next steps.

---

## Context

Electron apps are multi-process by design — similar to Chrome, each concern runs in its own OS process:

Today the Electron SDK only monitors the main process. Everything else is a blind spot — crashes, performance issues, and errors in child processes go undetected.

This prototype explored how to bring full process visibility to the Electron SDK, and what that data could look like in RUM.

---

## Approach with AI

This prototype was built over 4 sessions using Claude Code as the primary implementer, with the human acting as architect and domain expert.

| Session | Focus                                      | Outcome                                                    |
| ------- | ------------------------------------------ | ---------------------------------------------------------- |
| 1       | Landscape research + technical feasibility | Survey of 6 process mechanisms, 3 working prototypes       |
| 2       | RUM data model design                      | "Processes as views" concept, implementation plan          |
| 3       | Full prototype implementation              | Working SDK + playground with 12 Playwright test scenarios |
| 4       | Synthesis                                  | Conclusion doc with prioritized next steps                 |

---

## Demo Walkthrough

### Setup

- Open the playground app (`yarn playground`)
- Open the Datadog RUM Explorer filtered on the playground session
- Copy the session ID from the playground UI for filtering

### 1. Baseline: Main Process View

> Show: RUM Explorer session view

The main process already appears as a RUM view — this is the existing behavior. All new process views will appear alongside it in the same session.

### 2. Child Process Commands as Resources

> Click: **Spawn ls**, **Exec echo**

Each command appears as a RUM **Resource** (like an HTTP request), with:

- URL scheme indicating the method: `spawn://ls`, `exec://echo hello world`
- Duration and exit code as status

> Click: **Spawn fail**, **Exec timeout**

Failed commands also appear as Resources, with error details (ENOENT for missing binary, SIGTERM for timeout).

> Show: RUM Explorer resource list — the commands appear alongside network requests

### 3. Utility Process as a View

> Click: **Fork utility**

A new RUM **View** appears: `Utility: dd-demo-fork`. This is the key insight of the prototype — long-lived processes become views, just like pages in a browser. The view carries memory metrics from polling.

> Click: **Send message**

Messages between main and utility process are tracked. The utility process view stays open.

> Click: **Crash utility**

The utility process view ends and a RUM **Error** is emitted with the crash reason and stack trace. The view now shows its full lifecycle: creation, activity, and termination.

> Show: RUM Explorer — the utility view timeline alongside the main process view, with the error attached

### 4. Renderer Process and Container Hierarchy

> Click: **Crash renderer**

A renderer process view (`Renderer: {title}`) appears with a crash error. The important part here is the **container hierarchy**: browser-rum page views (from the web content) are nested under their renderer process view, which itself sits under the session. This gives a complete picture of which renderer hosted which page, and when it crashed.

> Show: RUM Explorer session timeline — main view, renderer view, utility view, all in the same session with errors and resources attached to the correct process

### 5. Memory Metrics

> Show: a utility or renderer process view detail — `memory_average` and `memory_max` fields

Process views carry memory metrics from `app.getAppMetrics()` polling (2s interval), using the same RUM view fields as mobile SDKs.

---

## Next Steps

The prototype validated the approach. Moving to production requires:

1. **Data model agreement** — process-specific fields currently sit in `context.*` (customer-owned). Production needs schema extensions (`view.process.pid`, `resource.process.args`, `error.process.reason`)
2. **dd-trace evaluation** — an in-progress dd-trace integration could handle child process command instrumentation, eliminating the trickiest monkey-patching work
3. **UI support** — the RUM Explorer labels all views as "Load Page", which is misleading for process views. Process views need a distinct display treatment

---

## Key Insights on AI Usage

1. **Self-validation infrastructure is the highest-leverage investment.** Session 1 required the human to click buttons and report results. After building a Playwright + mock intake harness, the AI agent iterated autonomously in session 3, dramatically increasing throughput.

2. **Human domain expertise steers, AI executes.** Every significant design decision (processes as views, container hierarchy, context fields are customer-owned) came from the human. AI was effective at implementing and exploring implications, but not at originating domain concepts.

3. **Parallel agents scale research, not implementation.** Sub-agents worked well for broad surveys (6 mechanisms, 2 PR reviews simultaneously). Implementation remained sequential — each step depended on the previous one.

4. **Screenshots bridge the observability gap.** When the AI can't access the RUM Explorer, user-provided screenshots were an effective substitute — the agent diagnosed duplicate events, wrong timestamps, and display issues from visual data alone.
