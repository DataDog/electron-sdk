# Development Guide

Development workflow, build configuration, and dependencies.

## Development Workflow

### Manual Checks

Run appropriate tests based on your changes:

- **Format & tint**: `yarn lint-staged` - Format and lint only staged files
- **Type check**: `yarn typecheck` - Verify TypeScript types
- **Build**: `yarn build` - Verify the SDK builds correctly
- **Unit tests**: `yarn test:unit` - For SDK code changes
- **E2E tests**: `yarn test:e2e:init && yarn test:e2e` - For integration testing

### Git Hooks

The project uses [husky](https://typicode.github.io/husky/) and [lint-staged](https://github.com/lint-staged/lint-staged) for git hooks:

- **pre-commit**: Runs `yarn lint-staged` to format and lint only staged files

Git hooks are installed automatically when running `yarn install` via the `prepare` script.

## Build System

### Dual Output (Rollup)

The SDK builds both CommonJS and ES modules for maximum compatibility:

- **CJS**: `dist/index.cjs` - For Node.js and Electron main process
- **ESM**: `dist/index.mjs` - For modern bundlers
- **Types**: `dist/index.d.ts` - Single TypeScript definition file

### Build-Time Constants

`@rollup/plugin-replace` injects constants at build time. They are declared in `src/globals.d.ts` and replaced with actual values during the Rollup build.

- **`__SDK_VERSION__`** — SDK version from `package.json`, used in telemetry events and RUM `ddtags`.

For unit tests, these constants are defined via Vitest's `define` option in `vitest.config.mjs`.

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
