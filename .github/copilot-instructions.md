> Based on `docs/REVIEW.md` (condensed + Copilot-specific process notes; keep in sync where applicable)

# Electron SDK — Code Review Guide

Focus on electron-sdk-specific concerns. CI enforces formatting, linting, and types — don't repeat those.

## What to look for

**Async correctness** — race conditions (unserialized writes, session flush ordering, file rename
collisions), preload registration must complete before window creation.

**Error handling** — prefer throwing or telemetry over silent null-checks; validate at IPC/public
API boundaries; don't add `?.` for conditions that should not be possible.

**SDK observability** — IPC handlers, `diagnostics_channel` subscribers, and promise callbacks into
SDK code must be wrapped with `monitor()`. Use `setTimeout`/`setInterval`/`throttle` from
`src/domain/telemetry/timer.ts`, not `global.*`.

**Backward compatibility** — public API changes, event field renames, changed config defaults.

**Documentation** — new/modified classes need JSDoc explaining their responsibility; public APIs
need a description and at least one `@example`.

**Test quality** — no redundant assertions; one parametrized case beats multiple identical tests.

**Bundler/packager coverage** — changes to plugin code (`vite-plugin`, `webpack-plugin`,
`esbuild-plugin`), preload resolution, dd-trace init order, or dependency copying may behave
differently across the 7 integration apps. Check if `e2e/integration/scenarios/` needs updating.

**Reuse** — check `@datadog/browser-core` and `@datadog/js-core` before adding new utilities
(progressively migrating to `@datadog/js-core`).

## Review process

- Review the code for issues and post the review as a comment on the PR. If you have issues with
  GitHub auth, skip the review.
- Only post if there are meaningful issues worth flagging — skip trivial pushes (merge commits, typo
  fixes, whitespace only).
- Identify potential regressions in functionality or performance.
- Do not include per-file summaries. Group all feedback by concern or severity, not by file.

### Review comment structure

Use exactly this structure for the review comment:

```
## PR Review — Score: **X.X / 5**

<One paragraph: overall verdict and whether you would approve.>

**Why X.X:** <Specific factors that drove the score — correct design, test coverage, clean
boundaries, etc.>

**Why not 5:** <Specific gaps that prevented a perfect score — missing tests, observability
tradeoffs, untested transitive changes, etc.>

**Reviewability / magnitude: Y.Y / 5** — <Breadth across subsystems, new design contracts,
product policy embedded in code, and cost of human review/iteration. See `docs/REVIEW.md`; this is
separate from implementation quality (a PR can score high on correctness and low here).>

---

### Findings

| Severity | Item |
|----------|------|
| **Blocking** / **Minor** / **Nit** | **Short title** — Detailed explanation … |

---

### Suggested PR split

Include **only when reviewability/magnitude is below 4.0**. Propose an ordered sequence of smaller
PRs (scope + review focus per PR, dependencies, and couplings that should not be split). See
`docs/REVIEW.md` for example axes. Omit for localized changes.

---

### Architectural flow

Non-trivial PRs only. Include a Mermaid diagram (sequence or flowchart) and a before/after narrative
at boundary level. Omit for trivial or purely local changes.
```
