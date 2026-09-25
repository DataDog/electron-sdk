# Code Review Guide

What to look for when reviewing a PR. Linters, the formatter, and the type checker already run in CI — don't
repeat what they enforce. Focus on the project-specific concerns below.

## What to look for

### Async correctness

Electron SDK code is highly concurrent: IPC messages, file I/O, session events, and span callbacks
all interleave. Look for:

- **Race conditions**: async calls that are not awaited or whose results can arrive out of order (e.g.
  creating a new session before the old one is flushed, recovering batch files that collide with
  existing ones).
- **Unserialized writes**: concurrent writes to shared state or disk without serialization.
- **Preload timing**: preload registration must complete before windows are created; async
  initialization must complete before events can flow.

### Error handling

The SDK favors observable failures over silent ones:

- Prefer throwing or reporting via telemetry over defensive null-checks for invalid payloads. Errors thrown from monitored callbacks are captured by the SDK's error wrapper and reported as telemetry.
- Validate external inputs (IPC messages, public API calls) early and fail loudly. Internal code can
  trust its invariants.
- Don't introduce `?.` or fallback values for conditions that should not be possible — surface them
  instead.

### SDK observability

All callbacks driven by Node.js or Electron (IPC handlers, `diagnostics_channel` subscribers, event
listeners) must be wrapped with `monitor()` so errors are captured by telemetry rather than
silently lost. This applies to Promise `.then`/`.catch` callbacks into SDK code too.

Use the SDK's `setTimeout`, `setInterval`, and `throttle` from `src/domain/telemetry/timer.ts`
instead of raw `global.setTimeout`/`global.setInterval`.

See `monitor` and `callMonitored` in `src/domain/telemetry/Telemetry.ts`.

### Backward compatibility

Breaking changes must be intentional. Watch for:

- Public API changes (renamed/removed methods, changed signatures in `InitConfiguration` or public
  classes).
- Event field renames or removals — downstream dashboards and monitors rely on stable field names.
- Changed default values for configuration options.

### Documentation

- New or modified classes should have a JSDoc comment explaining their responsibility and role in
  the system.
- New or modified public APIs should have a JSDoc comment with a clear description and at least one
  `@example`.

See `docs/CONVENTIONS.md` for full JSDoc conventions.

### Test quality

- **No redundant assertions**: multiple tests asserting the same behavior with different inputs add
  maintenance cost without coverage benefit — one parametrized case or a single representative
  example is enough.
- **Simple mocks**: avoid unnecessary indirection in test doubles; mock only what is needed.

### Bundler and packager coverage

Changes to bundler plugin code (`vite-plugin`, `webpack-plugin`, `esbuild-plugin`), preload
resolution, dd-trace initialization order, or dependency copying may behave differently across the
supported integration apps (electron-builder-vite, electron-vite, electron-vite-esm,
forge-esbuild-cjs, forge-esbuild-esm, forge-vite, forge-webpack).

Check whether the change warrants a new or updated scenario in `e2e/integration/scenarios/` and
whether the affected apps are covered.

### Reuse over reinvention

Before adding a new utility, check `@datadog/browser-core` and `@datadog/js-core` — utilities are
progressively migrating to `@datadog/js-core`, so check both. This applies to small type guards and
predicates too: use `getType` / `isIndexableObject` from `@datadog/js-core/util` for object shape
checks rather than open-coding `typeof x === 'object' && x !== null`.

## Change magnitude and reviewability

Assess **change magnitude and reviewability** separately from implementation quality. A PR can be
well-tested and correctly designed yet still be hard to review in one pass because it spans many
subsystems, introduces new contracts, or embeds product policy in code.

Consider:

- **Breadth** — How many boundaries change (transport, session/view, bridge, tracing, replay,
  profiling, config, public API, docs, e2e)?
- **New design** — Does the PR introduce ordering rules, new observables, or cross-module contracts
  reviewers must hold in memory?
- **Product choices** — Are semantics (admission vs storage, upload after denial, bridge limits)
  decided in implementation rather than a short design note?
- **Iteration cost** — Will a fix in one area likely re-open unrelated files?

Use a **Reviewability / magnitude** sub-score from **1.0 to 5.0** (same granularity as the main
score):

- **5.0** — Localized change; one subsystem or clear file scope; easy to review and iterate.
- **3.0–4.0** — Moderate spread or one cross-cutting concern with a narrow story.
- **1.0–2.5** — Large cross-cutting feature, many product decisions in diff, or high risk that human
  review missed interaction bugs.

The main **PR Review** score reflects correctness, tests, docs, and SDK-specific risks above. The
reviewability score reflects **process and merge risk**, not “bad code.” A strong implementation can
be **4.5+ on quality** and **2.5 on reviewability** at the same time.

When reviewability is **below 4.0**, include **Suggested PR split** in the review (see output format
below). Omit that section for localized PRs.

### Example split axes (Electron SDK)

When proposing splits, order PRs so each step keeps **today’s behavior** until the slice that
enables new behavior lands. Typical isolated slices:

1. **Consent state only** — `TrackingConsentState`, types, unit tests; no transport or collector
   gating yet.
2. **Transport / storage** — Pending vs authorized batch dirs, transition queue, filesystem
   migration and retry tests (pairs with `beforeObservable` ordering).
3. **Event model + assembly** — `storageConsent`, `consentTime`, `MainAssembly` / deferred export.
4. **Session + main-process views** — `SessionManager`, `ViewCollection`, view boundaries.
5. **Customer context** — Pause/commit persistence under consent (observer ordering).
6. **Bridge + renderer** — `RendererPipeline` admission; explicit product review.
7. **Tracing / propagation** — Process-global propagation check, span processor gating.
8. **Replay + profiling** — Specialized collectors last among functional slices.
9. **Public API + docs + e2e** — `setTrackingConsent`, README/architecture, scenarios (can trail
   each slice or land once at the end).

A **three-PR compromise** is often enough: **(A)** state + transport + event fields, **(B)**
collectors + contexts + assembly, **(C)** bridge semantics + tracing + public API + customer docs/e2e.

Call out **do-not-split** couplings (e.g. `beforeObservable` before collector emission; bridge
pending admission without pending storage).

## Pull request review format (agents)

Use this structure when posting a PR review (automation or manual). Read the sections above for what
to look for; do not treat CI pass/fail as a review finding.

```
## PR Review — Score: **X.X / 5**

<One paragraph: overall verdict and whether you would approve.>

**Why X.X:** <Correctness, design, tests, docs, SDK-specific risks.>

**Why not 5:** <Concrete gaps — not generic praise.>

**Reviewability / magnitude: Y.Y / 5** — <Breadth, new contracts, product choices in code,
iteration cost. One or two sentences.>

---

### Findings

<Short bullets grouped Blocking → Minor → Nit, or omit if none.>

---

### Suggested PR split

<Include only when reviewability/magnitude is below 4.0. Ordered list of PRs with scope and what
each review focuses on; mention dependencies and do-not-split couplings. Omit for localized PRs.>

---

### Architectural flow

<Non-trivial PRs only: Mermaid diagram + before/after boundary narrative. Omit for trivial/local
changes.>
```
