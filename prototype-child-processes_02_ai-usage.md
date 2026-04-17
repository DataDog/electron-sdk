# Child Process Monitoring — AI Usage Log

## Overview

This prototype ran over 4 sessions, progressing from landscape research → RUM data model design → working prototype → conclusion doc. AI (Claude Code) was the primary implementer throughout, with the human acting as architect, domain expert, and QA reviewer.

### How AI was used

- **Research & exploration**: parallel sub-agents surveyed mechanisms, parsed RUM schemas from GitHub, fetched product briefs via Google Workspace MCP, and reviewed PRs
- **Technical prototypes**: 3 parallel prototype worktrees (monkey-patching, utility process, MessagePort) built, run via background Electron shell, and tested interactively
- **Domain design**: iterative brainstorming (one question at a time, multiple choice) to converge on the "processes as views" data model
- **Domain prototype**: sequential plan execution with self-validation via Playwright + mock intake — the key enabler for agent autonomy
- **Domain prototype refinement**: screenshot-driven debugging where the human shared Datadog Explorer screenshots and the agent diagnosed and fixed issues
- **Organize conclusion**: parallel explore agents gathered findings, plan mode structured the document, iterative feedback refined it

### Key insights

1. **Self-validation infrastructure is the highest-leverage investment.** Session 1 required human button-clicking for every test. Session 2 planned a Playwright + mock intake harness. Session 3 used it — the agent iterated on failures autonomously, dramatically increasing throughput.

2. **Human domain expertise steers, AI executes.** Every significant design decision came from the human (processes as views, container hierarchy, context fields are customer-owned, path sanitization). AI was effective at implementing those decisions and exploring their implications, but not at originating them.

3. **Parallel agents scale research, not implementation.** Parallel sub-agents worked well for broad surveys (6 mechanisms × 9 dimensions), PR reviews (2 PRs simultaneously), and codebase exploration. Implementation remained sequential — each step depended on the previous one.

4. **Screenshots bridge the observability gap.** When the agent can't access the production tool (RUM Explorer), user-provided screenshots were an effective substitute — the agent diagnosed duplicate events, wrong timestamps, and UI display issues from visual data alone.

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

---

## Session 4: Conclusion Document + dd-trace PR Review

**Scope:** Synthesize findings from docs 00-04 into a conclusion document, review dd-trace integration PRs
**Outcome:** Conclusion doc (`_05_conclusion.md`), dd-trace evaluation findings

### How it went

**Planning phase:** 2 parallel Explore agents gathered all findings from docs 00-04 and searched for dd-trace references. Plan agent designed the document structure. Iterative refinement with user through plan mode.

**Writing phase:** Wrote the conclusion doc organized by topic with value/complexity ratings. Multiple rounds of user feedback reshaped the structure:

- Lifecycle events folded into their respective process topics (not standalone — they need a View to attach to)
- Data model moved to topic 1 as prerequisite, expanded with dedicated sections (processes as views, command execution as resource) and alternatives considered
- dd-trace evaluation placed right after data model for parallel exploration
- exec/spawn split into monkey-patching (challenging) vs collection (easy-medium) to surface where complexity actually lives

**dd-trace review phase:** 2 parallel Explore agents analyzed both PRs (electron-sdk#95, dd-trace-js#7002). Key finding: the current integration covers HTTP spans and IPC tracing only — no child_process, no utilityProcess, no lifecycle events. BrowserWindow wrapping is for preload injection, not monitoring. The existing `child_process` plugin exists in dd-trace but isn't enabled in the Electron integration.

**Data model exploration:** Investigated RUM Vitals and Feature Operations as alternative data models. Fetched official docs for operations monitoring. Concluded both are wrong abstraction level — operations sit above views (user-facing workflows), while our processes sit below/alongside views (infrastructure containers).

### Human interventions that shaped the outcome

- **Lifecycle events are coupled** — user pointed out that `getAppMetrics` and lifecycle events are useless without a RUM View to attach them to, leading to restructuring
- **Custom complexity scale** — user defined easy/medium/challenging instead of standard T-shirt sizing
- **Monkey-patching is child_process-only** — user confirmed that utility process and renderer use simple Electron API wrapping, no bundler concerns. Led to clearer separation in the doc
- **Feature Operations consideration** — user suggested checking if RUM vitals/operations could fit the data model, leading to documentation of why they were rejected
- **JIRA link** — user provided RUM-15282 for path sanitization bug, connecting prototype findings to existing backlog

### What worked well with AI

- **Parallel PR analysis** — 2 agents reviewed both PRs simultaneously, giving a complete picture of the dd-trace integration in one round
- **Iterative document refinement** — plan mode enabled back-and-forth on structure before writing
- **Web fetch for docs** — fetched official Datadog operations monitoring docs to evaluate the Feature Operations alternative

### What didn't

- **Initial topic ordering** — first draft had lifecycle events as standalone topic and data model buried at position 4. Required user feedback to restructure

### Improvement for future sessions

- **Review PRs early** — the dd-trace PR review answered most evaluation questions concretely. In future prototypes, review related in-progress work earlier to avoid speculative sections
