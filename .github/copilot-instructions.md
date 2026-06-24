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

---

### Findings

| Severity | Item |
|----------|------|
| **Blocking** / **Minor** / **Nit** | **Short title** — Detailed explanation … |

---

### Architectural flow

Explain the architectural flow of the change. Include a Mermaid diagram (sequence diagram or
flowchart — pick whichever best represents the change) followed by a before/after narrative
describing what changed at the boundary level.
```
