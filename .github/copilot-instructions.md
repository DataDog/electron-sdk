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
- For files touched by the PR, use `git log` to inspect recent commit history and search for merged
  PRs touching the same files. Flag cases where this PR might undo or conflict with recent
  intentional changes, citing the relevant commit hash or PR reference.
- Explain the architectural flow of the change in a separate section of your review comment.
- Score the PR between 1 and 5 (one decimal place). Be critical and justify the score.
