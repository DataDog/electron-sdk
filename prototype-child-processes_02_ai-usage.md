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
