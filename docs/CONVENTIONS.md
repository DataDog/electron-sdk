# Coding Conventions

## Code Documentation

Update relevant code documentation (JSDoc comments, inline comments) when modifying function behavior. Keep documentation in sync with implementation.

### Public API JSDoc

Public exports in `src/index.ts` are the customer's first contact with the SDK and surface in IDEs as autocompletion / hover docs. Keep the JSDoc focused on the **API contract**, not the implementation.

- Describe what the function does, what each parameter means, and what gets emitted on the wire.
- Mark experimental/preview status (`@experimental`) and deprecations (`@deprecated`).
- Cross-link to the README "feature" section with `@see README "<section name>"` for usage walkthroughs, parallel-operation patterns, and error semantics.
- **Do not put implementation reasoning in JSDoc** — internal scope routing, why local tracking is or isn't done, IPC bridge mechanics, etc. belong in `docs/ARCHITECTURE.md` or in a comment above the implementation, not in the public surface. Customers don't need it; they need to know how to call the function.

### `@deprecated` aliases

When renaming a public API after it has shipped (even as preview), keep the old name as a deprecated alias rather than breaking consumers:

- Tag the old export with `@deprecated Use <newName> instead.` JSDoc — IDEs surface the strikethrough at the call site.
- Have the old function delegate to the new one and emit a one-time runtime warning per method (track which warnings have fired in a `Set<string>` on the owning class).
- Drop the deprecated alias in the next major release.

See the `*FeatureOperation` → `*Operation` rename in `OperationCollection.ts` for the canonical implementation.

## Public API Checklist

When adding or renaming a top-level export from `src/index.ts`, every change below MUST land in the same PR:

- [ ] `src/index.ts` — export with full JSDoc (contract + `@experimental`/`@deprecated` if applicable).
- [ ] Domain implementation (`src/domain/.../*Collection.ts`) — actual behavior + unit tests.
- [ ] **`README.md`** — usage example under the matching `## API` subsection. Public docs live here; don't put walkthroughs in JSDoc.
- [ ] **Playground** — IPC handler + button so the new API is exercisable locally without writing a one-off Electron app.
- [ ] **e2e harness** (`e2e/app/src/main.ts`, `e2e/app/src/preload.ts`, `e2e/lib/mainPage.ts`) + at least one scenario in `e2e/scenarios/` exercising the API end-to-end against the local intake mock.
- [ ] If the public surface changes, **rebuild `dist/`** before typechecking the playground / e2e: they consume `@datadog/electron-sdk` via portal/yarn workspace and read from `dist/index.d.ts`. Stale dist is the most common cause of "Module has no exported member 'X'" after a rename.

## Defensive Input Validation at the Public API

TypeScript signatures only constrain TS callers. JS callers (and consumers compiling with looser settings) can pass anything. For public APIs that route into the event pipeline:

- Use `unknown` for the validation function's signature even if the public function is typed: `function validateArgs(method, name: unknown, options: unknown): boolean`.
- Use `@datadog/browser-core`'s `isIndexableObject(value)` to narrow `unknown` to a record shape before reading properties.
- Define small reusable type guards co-located with the validator: `function isValidString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }`.
- Reject and log via `displayError` (drop the event); see "displayError vs displayWarn" below.
- Pin the runtime contract with tests that bypass the type system (`badValue as unknown as ExpectedType`) — see `OperationCollection.spec.ts` "rejects non-object … as options" cases.

## Derive Types from Generated Schemas

`src/domain/rum/rumEvent.types.ts` is auto-generated from `rum-events-format` schemas. When a domain-internal type needs to mirror a schema field's enum or shape, **derive** it rather than duplicating the literals:

```ts
// good — single source of truth
type StepType = NonNullable<RumVitalOperationStepEvent['vital']>['step_type'];

// avoid — drifts when the schema changes
type StepType = 'start' | 'end' | 'update' | 'retry';
```

Schema regenerations propagate automatically. See `src/domain/rum/rawRumData.types.ts` for `RawRumVital` derivation pattern.

## `displayError` vs `displayWarn`

`src/tools/display.ts` exports both:

- **`displayError`** — the SDK is **dropping** the event or refusing to do something the customer asked. Examples: blank operation `name`, non-object `options`, invalid `failureReason`. Customer needs to fix this for the data to flow.
- **`displayWarn`** — the SDK is **still emitting** the event but flagging something suspicious. Examples: operation `name` doesn't match the backend's character-set regex (backend is the source of truth, so we emit and let it decide). Customer may want to fix this but their data isn't being lost.

Match the existing convention; don't escalate a warning to an error or vice versa without considering the drop-vs-emit semantics.

## File I/O

Use async `node:fs/promises` APIs for file operations in production code:

```typescript
import * as fs from 'node:fs/promises';

// Reading
const data = await fs.readFile(filePath, 'utf8');

// Writing
await fs.writeFile(filePath, JSON.stringify(state));

// Checking existence
try {
  await fs.access(filePath);
} catch {
  // File does not exist
}

// Deleting
await fs.unlink(filePath);
```

**Note:** The playground uses sync APIs for simplicity, but SDK code should use async APIs.

## Browser-Core Utilities

Prefer utilities from `@datadog/browser-core` over custom implementations. Examples:

- `generateUUID()` - UUID v4 generation
- `Observable` - Pub/sub pattern
- `ONE_HOUR`, `ONE_MINUTE`, `ONE_SECOND` - Time constants

```typescript
import { generateUUID, Observable, ONE_MINUTE } from '@datadog/browser-core';
```

## Imports and Exports

- **`node:` protocol** for Node.js builtins (enforced by `unicorn/prefer-node-protocol`)
- **Barrel imports** when an `index.ts` exists (enforced by `force-barrel-imports`)
- **Only export what is needed** — keep internal implementation details private

## Cleanup

Components should provide a `stop()` method that unsubscribes listeners to avoid leaking between tests and to support a future full SDK stop. Format hooks are tied to SDK lifetime and don't need cleanup.

## DRY

Avoid code duplication. When the same logic is needed in multiple places, extract a shared method.

## State Abstraction

When several fields evolve together, extract them into a meaningful abstraction (typed interface/object) rather than keeping loose private fields.

## Classes over Factory Functions

Prefer classes over factory functions for stateful tools. Classes provide clear visibility modifiers (`private`, `readonly`) and a familiar API surface.

When a class requires async initialization (e.g. loading from disk), use a **static async factory** with a private constructor:

```typescript
class MyTool<T> {
  private constructor(/* ... */) {}

  static async init<T>(opts: { /* ... */ }): Promise<MyTool<T>> {
    // async setup
    return new MyTool(/* ... */);
  }
}
```

This ensures instances are always fully initialized — callers cannot forget to call `init()`.

## Class File Organization

```
/**
 * JSDoc
 */
class Name {
  // constructor
  // first public method
  // private methods called by the first public method
  // second public method
  // private methods called by the second public method
}
// utility methods
```

JSDoc and class declaration at the top, methods ordered by usage to facilitate review and code exploration.
