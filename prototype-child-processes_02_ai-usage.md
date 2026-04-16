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

---

## Session 3: RUM Mapping Prototype Implementation + Refinements

**Scope:** Implement all 5 steps of the prototype plan, then iterative refinements based on user testing in Datadog
**Outcome:** Full working prototype (12 Playwright scenarios), findings doc (`_04_rum-mapping-prototype.md`), multiple bug fixes

### How it went

**Implementation phase:** Sequential execution of the 5 plan steps. Each step: implement SDK collection → add playground buttons/IPC → write Playwright scenario → run checks (typecheck, lint, unit tests, playground tests) → commit.

**Refinement phase:** User tested the prototype against real Datadog RUM Explorer. Iterative cycle: user spots issue in screenshot → agent diagnoses → implements fix → verifies with tests → commits. Covered: duplicate resources, view date bug, renderer timing, path sanitization, view naming.

### Human interventions that shaped the outcome

- **Hidden window in test mode** — user requested playground window stays hidden during tests to avoid disruption
- **Distinct serviceName per utility button** — user asked for unique names (`dd-demo-fork`, `dd-demo-message`, `dd-demo-crash-worker`) to ease event identification in Explorer
- **Duplicate resource events** — user spotted duplicates in Explorer screenshot, leading to discovery of exec→execFile→spawn chain and close+error double-emission
- **Main view date bug** — user noticed main process view had wrong start time in Explorer, revealing pre-existing bug where `commonContext` hook's `Date.now()` overwrote the view creation time
- **Renderer view timing** — user asked how to ensure renderer view predates browser-rum events, leading to `did-start-navigation` + lazy creation with backdating approach
- **Bridge-level detection alternative** — user suggested creating renderer views at bridge level (earlier than Assembly) as production improvement
- **Path sanitization** — user flagged filesystem paths leaking in events. Iterative debugging: `[APP_PATH]` placeholder → discovered it broke Datadog UI display → switched to stripping path entirely
- **Memory on view fields** — user pointed out existing `view.memory_average`/`view.memory_max` schema fields (from mobile SDKs) instead of using context
- **CPU not prototyped** — user decided to skip CPU metrics after discussion of unit mismatch (ticks vs seconds) and lack of Datadog display support
- **Method-specific URL schemes** — user preferred `spawn://`, `exec://` over generic `child_process://` for resource URLs
- **Renderer view naming** — user wanted page title for grouping, pid in context only, with `Renderer:` prefix for consistency with `Utility:`

### What worked well with AI

- **Self-validating test harness** — the Playwright + mock intake setup (session 2's improvement) worked as designed. Agent ran `yarn playground:test` after each change and iterated on failures without human intervention
- **Screenshot-driven debugging** — user shared Datadog Explorer screenshots, agent diagnosed issues from the visual data (duplicate events, wrong timestamps, missing URLs)
- **Incremental commits** — plan steps + fixup commits kept history clean and reviewable
- **Parallel exploration agents** — used for initial codebase understanding (e2e infra, SDK types, Electron APIs)

### What didn't

- **Rollup namespace wrapper** — took multiple iterations to discover that `import * as mod` produces a wrapper object that `Object.defineProperty` can't patch through. Required reading bundled output to diagnose.
- **Path sanitization iteration** — 3 rounds needed: `[APP_PATH]` placeholder → broken UI → strip path entirely → discovered `sanitizeAppPaths` call was dropped during debug logging → final fix

