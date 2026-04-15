# Child Process Monitoring — AI Usage Log

---

## Session 1: Research + Technical Prototypes

**Scope:** Landscape survey of 6 mechanisms + prototyping 3
**Outcome:** Research doc, 3 prototype worktrees, documented findings

### How it went

**Research phase:** 3 sub-agents in parallel, each covering 2 mechanisms across 9 dimensions. Compiled into priority matrix.

**Prototyping phase:** Attempted 3 parallel implementation agents. Each prototype was built, run via background shell, and tested interactively (human clicks buttons, agent reads logs).

### Human interventions that shaped the outcome

- Added evaluation dimensions (bundler impact, overhead, data flow)
- Asked about existing instrumentation libraries → discovered `shimmer`, RITM, IITM; tested `diagnostics_channel` (not available for child_process in Node 22)
- Asked about parentPort reliability for customers → identified message leaking, shaped MessagePort recommendation
- Prompted exit(1) vs crash test → discovered `child-process-gone` can't distinguish them

### What worked well with AI

- Parallel research agents for broad surveys
- Running Electron app in background + reading logs for validation
- Running diagnostic scripts in Electron to investigate runtime behavior (`__importStar` property descriptors, `diagnostics_channel` availability)
- Iterative fix cycles (error → diagnose → fix → rebuild → retest)

### What didn't

- First monkey-patching approach (3 iterations needed: direct assignment → `Object.defineProperty` → `require()` instead of `import *`)
- Stale `tsconfig.tsbuildinfo` causing silent build failures

### Improvement for future sessions

- **Agents should self-verify prototypes** — in this session, the human had to click buttons and report results. For future prototypes, design a self-test mode (e.g. headless Electron with programmatic IPC triggers + assertion checks) so agents can iterate without human intervention.

---

## Session 2: RUM Concept Mapping + Prototype Planning

**Scope:** Map child process telemetry to RUM events, plan prototype implementation
**Outcome:** RUM mapping doc (`_03_rum-mapping.md`), implementation plan (`.plans/cozy-booping-mango.md`)

### How it went

**Exploration phase:** 2 parallel sub-agents explored the SDK architecture (event pipeline, RUM types, raw data types, Assembly, Transport) and existing child process code. Fetched RUM event schemas from `rum-events-format` repo (error, action, resource, view, vital, common, view-container, view-properties). Read the product brief via Google Workspace MCP.

**Brainstorming phase:** Iterative Q&A with the user (8 rounds), one question at a time. Explored alternatives, proposed mappings, refined based on user feedback. Resulted in the "processes as views" model.

**Planning phase:** Designed implementation approach (playground + Playwright + intake for agent self-validation), defined steps with priorities.

### Human interventions that shaped the outcome

- **Processes as views concept** — user proposed modeling long-lived processes as RUM views to attach performance metrics, inspired by how the main process is already a view
- **Container hierarchy** — user pointed to `_view-container-schema.json` and the existing `Assembly.ts:64` (`container.view.id`), revealing the parent-child view mechanism already exists for Electron
- **Mobile SDK metrics pattern** — user pointed to `_view-properties-schema.json` showing `memory_average`, `cpu_ticks_per_second` on views, suggesting we follow the same pattern
- **Context attributes are customer-owned** — user flagged that `context` fields cannot be used in production for SDK data, only as prototype placeholders. Production needs schema extensions.
- **Spawn/exec errors on resource, not separate Error** — user requested error info stay on the Resource event itself (like failed HTTP requests), avoiding separate Error events
- **Resource event lifecycle** — user suggested starting resource tracking at spawn time but waiting for completion to emit, and correlating `child-process-gone` to ongoing resources (clarified: only applies to utility processes, not Node.js child_process)
- **Product brief reference** — user shared Google Doc link, asked to flag brief recommendations but allow challenging them
- **Playground test harness** — user wanted agents to validate without clicking buttons and without RUM Explorer. Explored 3 approaches (e2e app, playground headless, playground + Playwright + intake). User chose C (Playwright clicking playground buttons + intake assertions) because it reuses demo buttons

### What worked well with AI

- Fetching and parsing RUM event schemas from GitHub API for analysis
- Reading product brief via Google Workspace MCP (after reauthentication)
- One-question-at-a-time brainstorming with multiple choice options
- Exploring e2e infrastructure (2 parallel agents) to inform the validation approach
- Iterating on the test harness design based on user feedback

### What didn't

- Product brief JSON was 431KB raw — needed Python extraction to get readable text

### Improvement for future sessions

- **Playground test harness** — the plan includes setting up Playwright + intake for the playground (Step 0). Once built, agents can self-validate by clicking buttons and asserting on captured events, eliminating the manual validation bottleneck from session 1.
