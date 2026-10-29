# Coding Conventions

## Design

### Minimal First

Implement the minimal design that handles the cases at hand. Don't add a defensive mechanism (queue, buffer, retry,
flush, retention) without a concrete case it handles: list it as a follow-up with what would trigger adding it.

### Single Responsibility

A component owns one concern, and logic sits next to the data it operates on. A function reads at a single level of
abstraction: extract helpers rather than mixing orchestration and details (e.g. `init` only wires components).

When an existing API doesn't fit, extend it rather than working around it.

### Naming

One concept, one name: reuse the existing term across code, config, env vars, and docs rather than introducing a
synonym. Don't mix vocabularies from different SDKs (e.g. mobile "event mapper" vs browser "beforeSend").

### Cross-SDK Parity

Browser SDK, mobile SDKs, and dd-trace implementations are the default reference: matching their behavior and API eases
maintenance and customer usage. Diverge only when the behavior doesn't make sense for Electron, and don't port a
behavior that has no use case on our platform just because another SDK has it.

When logic is copied from another SDK, say so in a comment, with a link to the source and a TODO referencing a ticket if
it should eventually be shared.

### State Abstraction

When several fields evolve together, extract them into a meaningful abstraction (typed interface/object) rather than
keeping loose private fields.

### DRY

Avoid code duplication. When the same logic is needed in multiple places, extract a shared method.

### Reuse

Before adding a new utility, check `@datadog/browser-core` and `@datadog/js-core`: utilities are progressively migrating
to `@datadog/js-core`, so check both. This applies to small type guards too: use `getType` / `isIndexableObject` from
`@datadog/js-core/util` rather than open-coding `typeof x === 'object' && x !== null`.

```typescript
import { generateUUID, Observable, ONE_MINUTE } from '@datadog/browser-core';
```

## Classes

### Classes over Factory Functions

Prefer classes over factory functions for stateful tools. Classes provide clear visibility modifiers (`private`,
`readonly`) and a familiar API surface.

When a class requires async initialization (e.g. loading from disk), use a **static async factory** with a private
constructor. The factory only resolves the async dependencies; all domain setup (subscriptions, wiring) lives in the
constructor:

```typescript
class MyTool {
  private constructor(store: Store, initialState: State) {
    // domain setup
  }

  static async start(path: string): Promise<MyTool> {
    const store = await Store.load(path);
    return new MyTool(store, store.read());
  }
}
```

This ensures instances are always fully initialized: callers cannot get an instance without going through the factory.

Don't add a separate instance `start()` method when it would always be called right after construction: the
constructor starts the component and `stop()` releases it. Avoid fully static classes: use module-level functions, or a static method on the
class that uses it.

### Cleanup

A component that owns a releasable resource (a timer, an observable subscription, a file watcher) must expose a `stop()`
that releases it. Instantiating such a component in a test then requires releasing that resource on teardown — via
`stop()`, or by controlling it (e.g. `vi.useFakeTimers()` for timers) — so it does not leak into other tests.

Components that hold no such resource don't need a `stop()`, and a `stop()` with no production caller is fine as long as
it releases a real resource. Format hooks are tied to SDK lifetime and don't need cleanup.

## Public API

### Runtime Validation

TypeScript signatures don't constrain JavaScript callers. Validators accept `unknown` and narrow it before reading
properties. Reuse `src/tools/validation.ts` helpers and `isIndexableObject` from `@datadog/js-core/util`.

Test the runtime contract with values that bypass the type system (`badValue as unknown as ExpectedType`), asserting
the diagnostic and whether the event is emitted. See `validateDurationVitalArgs` in [`api.ts`](../src/api.ts) and
[`api.spec.ts`](../src/api.spec.ts), including validation of fields inside the options object.

### Deprecated Aliases

When preserving compatibility during an API rename, keep the old export as a wrapper. Its call path must warn once per
deprecated method and run the shared implementation. Mark the export with `@deprecated Use <newName> instead.`.

For operation APIs, the wrappers in [`src/index.ts`](../src/index.ts) report usage and call the deprecated collection
methods. `handleDeprecated` in [`OperationCollection.ts`](../src/domain/rum/operation/OperationCollection.ts) emits the
warning, then runs the shared validation and event-construction handler.

State the removal timing in both the JSDoc and warning. Existing operation aliases say "will be removed in a future
major release".

Honor an alias's documented removal schedule. Other deliberate breaking changes remain allowed during 0.x releases
under the [backward compatibility policy](REVIEW.md#backward-compatibility).

### Types from Schemas

Derive internal types from generated schema fields instead of duplicating their enums or shapes:

```typescript
type StepType = NonNullable<RumVitalOperationStepEvent['vital']>['step_type'];
```

See [`rawRumData.types.ts`](../src/domain/rum/types/rawRumData.types.ts) for examples and
[RUM Events Schema Management](DEVELOPMENT.md#rum-events-schema-management) for source files and regeneration commands.

## Error Handling

The SDK never throws into customer code, and favors observable failures over silent ones:

| Source of the problem                       | Handling                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Invalid configuration                       | Report with `display.error`; `init` resolves to `false`                 |
| Public API validation                       | Preserve the API's established diagnostic level and acceptance behavior |
| Invalid external data (IPC, files on disk)  | Validate early and drop                                                 |
| Broken internal invariant                   | Throw: `monitor()` reports it as telemetry. No `?.` or fallback values  |
| Customer callback failure (e.g. beforeSend) | Report with `display.error` and keep the event; no SDK telemetry        |

Diagnostic severity does not determine whether input is accepted. Operation validators reject a blank name with
`display.error`; `setUserInfo` without an ID and invalid user/account standard fields use `display.warn` and leave the
context unchanged. Operation names outside the backend character set and invalid `failureReason` values warn but still
emit. Keep each API's established validation behavior; diagnostic wording must describe whether the call takes effect.

## Telemetry

- Don't send customer-configured values (e.g. tags, context) in SDK telemetry.
- A new configuration option is reported in configuration telemetry (`reportConfiguration`).
- A new public API reports its usage with `addUsage({ feature: '<api-name>' })`.

## Documentation

### Comments

Comments explain why, not what: default to no comment when the code reads on its own. Keep them short, back claims with
evidence, and wrap them at the Prettier `printWidth` (120).

Comments and docs describe the current state, not the change that produced it: no "this PR" or "the new behavior".
Reference an explicit PR or ticket when history matters. Update them when modifying the behavior they describe.

### JSDoc

- Classes: a JSDoc comment explaining their responsibility and role in the system.
- Customer-facing API (exports of `src/index.ts`, bundler plugin entry points) and `InitConfiguration` options: a
  description and at least one `@example`.
- Public exported types (event schemas, unions, generated types): a description only.

Public API JSDoc describes the contract: behavior, parameters, emitted data, and `@experimental` / `@deprecated` status
where applicable. Link to the relevant README API reference, setup instructions, or feature walkthrough for usage
details. Scope routing, IPC mechanics, and other implementation reasoning belong in `docs/ARCHITECTURE.md` or internal
comments.

### Public Docs

- A PR documents only what is true once it lands; behavior shipped by a later PR is documented by that PR.
- The README documents a feature once it is exposed to customers or enabled by default, with every option key. Don't
  document test-only options.

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

## Imports and Exports

- **`node:` protocol** for Node.js builtins (enforced by `unicorn/prefer-node-protocol`)
- **Barrel imports** when an `index.ts` exists (enforced by `local/no-internal-modules`)
- **Only export what is needed** — keep internal implementation details private

## File Organization

### Classes

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

### Modules

Constants and types first, then each exported function followed by the internal helpers it uses, in order of first use.
A helper shared by several functions goes after its first user.

## Pull Requests

Keep a PR to one purpose: unrelated changes go in a separate PR.
