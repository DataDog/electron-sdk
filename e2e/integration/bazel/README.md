# Bazel/rules_js with isolated pnpm dependencies

This separate fixture reuses `electron-builder-vite` sources and the SDK tarball from the current
worktree. It adds coverage without changing the existing apps' `node-modules` linker.

| Project              | Runtime dependency staging                                                |
| -------------------- | ------------------------------------------------------------------------- |
| `bazel-default-copy` | `copyRuntimeDependencies: false`; Bazel stages the SDK dependency closure |
| `bazel-plugin-copy`  | `copyRuntimeDependencies: true`; only the plugin's output is staged       |

Requirements: Bazelisk and the root Yarn dependencies installed. Bazel provides pinned Node and
pnpm toolchains. No private remote cache is required.

From the repository root:

```sh
node scripts/prepare-bazel-integration.ts
cd e2e/integration/generated/bazel-vite
bazel run @pnpm//:pnpm -- --dir "$PWD" install --lockfile-only --ignore-scripts
bazel build //:default-copy_app //:plugin-copy_app
cd ../../../..
yarn playwright test -c e2e/integration/bazel/playwright.config.ts
```

Each test copies its staged output to a temporary directory outside the checkout and Bazel cache,
rejects dependency links escaping that directory, verifies the tracer's lexer dependencies resolve
inside it, and checks renderer error delivery and a traced main-process HTTP resource. The plugin-copy
case reproduces the non-hoisted resolution failure from [#179](https://github.com/DataDog/electron-sdk/pull/179).
This stages an Electron application directory; it does not create an installer or exercise signing.

Generated manifests, lockfiles, tool outputs, and the SDK tarball stay under `generated/`.
Dependency lifecycle scripts are disabled for the Bazel graph: the Electron executable comes from
root development dependencies. The renderer is built as a library entry to avoid Vite HTML path
canonicalization across Bazel's input symlinks. The main-process build uses the maintained Vite
configuration's `default-copy` and `plugin-copy` modes, with the output directory overridden for Bazel.
