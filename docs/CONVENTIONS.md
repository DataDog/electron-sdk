# Coding Conventions

## Code Documentation

Update relevant code documentation (JSDoc comments, inline comments) when modifying function behavior. Keep documentation in sync with implementation.

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
