# Development Guide

Key architectural decisions for developers and AI agents working on this project.

## Documentation Policy

When making changes that impact development workflows or architecture, update the relevant section in this document. This includes:

- Build system changes
- New directory structures or conventions
- Testing infrastructure updates
- Dependency management processes
- Module system or TypeScript configuration changes

## Development Workflow

### Git Hooks

The project uses [husky](https://typicode.github.io/husky/) for git hooks:

- **pre-commit**: Automatically runs `yarn format && yarn lint` before each commit

Git hooks are installed automatically when running `yarn install` via the `prepare` script.

### Manual Checks

Before committing changes, the pre-commit hook automatically runs format and lint. Additionally, run appropriate tests based on your changes:

- **Type check**: `yarn typecheck` - Verify TypeScript types
- **Build**: `yarn build` - Verify the SDK builds correctly
- **Unit tests**: `yarn test:unit` - For SDK code changes
- **E2E tests**: `yarn test:e2e:init && yarn test:e2e` - For integration testing

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
3. Maintain alphabetical order by package name
4. Fetch license info from GitHub raw LICENSE file

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
- **e2e/lib/**: Shared test utilities (Playwright fixtures for app launch/cleanup)
- **e2e/scenarios/**: Test files using Playwright

Tests import custom `test` and `expect` from `lib/helpers.ts` for automatic app lifecycle management.
