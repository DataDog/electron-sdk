# Development Guide

Development workflow, build configuration, and dependencies.

## Getting Started

After cloning, run the one-time setup script:

```sh
yarn repo:init
```

This initializes the git submodule, installs playground and e2e app dependencies, and builds the SDK.

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

## Commit messages and Pull Request titles

Messages should be concise but explanatory. We are using a convention inspired by [gitmoji][1], to
label our Commit messages and Pull Request titles:

### User-facing changes

- 💥 **Breaking change** - Breaking API changes
- ✨ **New feature** - New public API, behavior, event, property
- 🐛 **Bug fix** - Fix bugs, regressions, crashes
- ⚡️ **Performance** - Improve performance, reduce bundle size
- 📝 **Documentation** - User-facing documentation
- ⚗️ **Experimental** - New public feature behind a feature flag

### Internal changes

- 👷 **Build/CI** - Dependencies, tooling, deployment, CI config
- ♻️ **Refactor** - Code restructuring, architectural changes
- 🎨 **Code structure** - Improve code structure, formatting
- ✅ **Tests** - Add/fix/improve tests
- 🔧 **Configuration** - Config files, project setup
- 🔥 **Removal** - Remove code, features, deprecated items
- 👌 **Code review** - Address code review feedback
- 🚨 **Linting** - Add/fix linter rules
- 🧹 **Cleanup** - Minor cleanup, housekeeping
- 🔊 **Logging** - Add/modify debug logs, telemetry

## Dependency Management

### Adding Dependencies

When adding a new dependency, you must update `LICENSE-3rdparty.csv`.

`LICENSE-3rdparty.csv` tracks four categories of dependencies:

| Component   | Scope                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| `npm-prod`  | NPM production deps (`dependencies` in any `package.json`)             |
| `npm-dev`   | NPM dev deps (`devDependencies` in any `package.json`)                 |
| `rust-prod` | Rust crates compiled into the distributed WASM binary (non-dev deps)   |
| `rust-dev`  | Rust crates used only during minidump-processor development (dev-deps) |

**Section order** (must be respected):

1. `npm-prod`
2. `rust-prod`
3. `npm-dev`
4. `rust-dev`

**Rules for all:**

1. Format: `Component,Origin,License,Copyright`
2. Do not include version numbers — list package name only
3. Maintain alphabetical order by package name within each component group
4. Fetch license info from the crate/package repository

**Validation:** Run `node scripts/check-licenses.ts` to verify both NPM and Rust entries are in sync.

### Bundled vs runtime dependencies

This SDK is fully bundled: Rollup inlines all packages not listed in `external` (`rollup.config.mjs`).
Currently `external` contains only `['electron']`.

- **`devDependencies`**: use for packages inlined by Rollup — consumers don't need to install them (e.g. `@datadog/browser-core`).
- **`dependencies` + add to `external`**: only for packages that must remain a shared singleton at runtime (e.g. `electron`).

### License Information Sources

- NPM: check package repository's LICENSE or `package.json`
- Rust crates: check `Cargo.toml` license field or repo LICENSE file; `cargo metadata` reports the license field for registered crates

### GitHub Actions

GitHub Actions must be pinned to a **full commit SHA** (DataDog enterprise policy). Use the version tag as a comment for readability:

```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

To find the SHA for a given version, check the action's GitHub releases page or run:

```bash
git ls-remote --tags https://github.com/actions/checkout | grep 'v4\.'
```

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

## Releasing

### Prerequisites

- [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)
- `$EDITOR` environment variable set (e.g. `export EDITOR=vim` in your shell profile)
- npm Trusted Publisher configured on npmjs.com
- Maintain permission on the GitHub repository (required to push tags)

### Release flow

#### 1. Prepare the release (run locally)

```sh
yarn release
```

The script will:

1. Validate prerequisites (`$EDITOR`, `gh` auth, clean working tree)
2. Sync with main and install latest deps
3. Prompt you to choose a version bump (patch / minor / major / custom)
4. Generate a changelog draft and open it in `$EDITOR` for review
5. Create a `release/vX.Y.Z` branch, commit, push, and create an annotated tag `vX.Y.Z`
6. Open a GitHub PR

**Dry-run mode** (validates all checks and previews changelog without git changes):

```sh
yarn release --dry-run
```

#### 2. Review and merge the PR

- Review the generated changelog in the PR
- Edit `CHANGELOG.md` if needed (push commits directly to the release branch)

> **⚠️ Warning:** The release tag is created **before** the PR is merged. If you push fixup commits to the release branch, you **must** move the tag to the latest commit before merging — otherwise those commits will be excluded from the published release:
>
> ```sh
> git tag -a -f vX.Y.Z -m "vX.Y.Z"
> git push -f origin vX.Y.Z
> ```

Merge the PR when ready.

#### 3. Trigger the publish workflow

A Slack message in `#rum-electron-sdk-ops` is sent when the tag is pushed in step 1. It includes a link to the GitHub Actions publish workflow and reminds you to review and merge the PR first.

Open the workflow link, click **Run workflow**, and select the tag `vX.Y.Z` in the ref dropdown.

> **Dry-run option:** Enable the `dry_run` toggle to run the full pipeline (build, validate, extract changelog) without publishing to npm or creating a GitHub release. Useful to validate the pipeline before the real publish.

[1]: https://gitmoji.carloscuesta.me/
