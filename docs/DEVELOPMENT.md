# Development Guide

Key architectural decisions for developers and AI agents working on this project.

## Documentation Policy

When making changes that impact development workflows or architecture, update the relevant section in this document. This includes:

- Build system changes
- New directory structures or conventions
- Testing infrastructure updates
- Dependency management processes
- Module system or TypeScript configuration changes

**Keep it concise**: Document the essential information only. Prefer command examples and brief explanations over lengthy descriptions. Skip obvious details and implementation rationale unless critical for understanding.

## Development Workflow

### Git Hooks

The project uses [husky](https://typicode.github.io/husky/) and [lint-staged](https://github.com/lint-staged/lint-staged) for git hooks:

- **pre-commit**: Runs `yarn lint-staged` to format and lint only staged files

Git hooks are installed automatically when running `yarn install` via the `prepare` script.

### Manual Checks

Before committing changes, the pre-commit hook automatically runs format and lint on staged files. Additionally, run appropriate tests based on your changes:

- **Type check**: `yarn typecheck` - Verify TypeScript types
- **Build**: `yarn build` - Verify the SDK builds correctly
- **Unit tests**: `yarn test:unit` - For SDK code changes
- **E2E tests**: `yarn test:e2e:init && yarn test:e2e` - For integration testing

## Script Guidelines

### Script Preferences

When adding automation scripts to the project:

1. **Prefer Node.js scripts** over bash scripts for:
   - Complex logic and error handling
   - Cross-platform compatibility
   - TypeScript integration
   - JSON/data processing

2. **Bash scripts belong in `scripts/cli`**:
   - All bash scripts should be implemented as commands in `scripts/cli`
   - Use `cmd_<name>` function pattern for new commands
   - Accessible via `scripts/cli <command>` or `yarn` scripts
   - Example: `scripts/cli build_fork` or `yarn postinstall`

3. **Examples**:
   - ✅ Node.js: `scripts/generate-schema-types.ts` (complex JSON processing)
   - ✅ CLI command: `scripts/cli build_fork` (build automation)
   - ❌ Standalone bash: `scripts/build-fork.sh` (should be in CLI instead)

## Coding Guidelines

### Code Documentation

Update relevant code documentation (JSDoc comments, inline comments) when modifying function behavior. Keep documentation in sync with implementation.

### File I/O

Use async `fs/promises` APIs for file operations in production code:

```typescript
import * as fs from 'fs/promises';

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

### Browser-Core Utilities

Prefer utilities from `@datadog/browser-core` over custom implementations:

- `generateUUID()` - UUID v4 generation
- `Observable` - Pub/sub pattern
- `ONE_HOUR`, `ONE_MINUTE`, `ONE_SECOND` - Time constants

```typescript
import { generateUUID, Observable, ONE_MINUTE } from '@datadog/browser-core';
```

## Build System

### Dual Output (Rollup)

The SDK builds both CommonJS and ES modules for maximum compatibility:

- **CJS**: `dist/index.cjs` - For Node.js and Electron main process
- **ESM**: `dist/index.mjs` - For modern bundlers
- **Types**: `dist/index.d.ts` - Single TypeScript definition file

## Dependency Management

### Adding Dependencies

When adding a new dependency, you must update `LICENSE-3rdparty.csv`:

1. Add entry with format: `Component,Origin,License,Copyright`
2. Use `dev` prefix for all devDependencies (including playground)
3. **Do not include version numbers** - list package name only
4. Maintain alphabetical order by package name
5. Fetch license info from GitHub raw LICENSE file

**Example:**

```csv
dev,chokidar,MIT,Copyright (c) 2012 Paul Miller / Elan Shanker
```

### License Information Sources

- Check package repository's LICENSE or package.json
- GitHub: `https://raw.githubusercontent.com/{org}/{repo}/master/LICENSE`
- Extract copyright holder from license file header

### Updating Dependencies

Always use latest stable versions for new dependencies. Check with:

```bash
npm view <package>@latest version
```

## RUM Events Schema Management

Types auto-generated from [rum-events-format](https://github.com/DataDog/rum-events-format) submodule → `src/rumEvent.types.ts` (committed).

```bash
yarn json-schemas:sync      # Update submodule + regenerate types
yarn json-schemas:generate  # Regenerate types only
```

**Fork dependency**: Uses `bcaudan/json-schema-to-typescript#bcaudan/add-readonly-support` (v11.0.1) for `readonly` modifier support. Built lazily when generating types (not during `yarn install`) to avoid CI rate limiting.

⚠️ Never edit `src/rumEvent.types.ts` manually.

## Playground Architecture

### Module System Split

The playground uses different module systems due to Electron constraints:

- **main.ts, preload.ts**: CommonJS (`tsconfig.json`) - Electron requires this
- **renderer.ts**: ES modules (`tsconfig.renderer.json`) - Runs in browser, can use modern modules
- **ESLint**: Uses `tsconfig.eslint.json` that includes all files for type-checking

**Critical detail:** Using `export {}` in CommonJS code generates `exports` references that fail in browser. Separate compilation configs prevent this.

### Hot Reload System

Two watchers handle different reload scenarios:

1. **electron-reloader** (3s startup delay) - Watches playground files, reloads windows
2. **chokidar** (5s grace period, 200ms debounce) - Watches parent SDK's dist/, clears require cache, relaunches app

Grace periods prevent reload loops during initial TypeScript compilation.

No watching of HTML changes for now to avoid extra complexity.

## E2E Testing

### Directory Structure

- **e2e/app/**: Minimal Electron app used as test fixture (main, preload, renderer)
- **e2e/lib/**: Shared test utilities
  - `helpers.ts`: Playwright fixtures for app launch/cleanup
  - `intake.ts`: Local HTTP server that captures RUM events sent by the SDK for testing
- **e2e/scenarios/**: Test files using Playwright

Tests import custom `test` and `expect` from `lib/helpers.ts` for automatic app lifecycle management.

The intake server runs on a dynamic port (OS-assigned) to avoid conflicts and integrates via Playwright fixture for automatic lifecycle management.
