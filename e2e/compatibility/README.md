# Electron Compatibility Testing

Compatibility tests run the existing minimal E2E scenarios and realistic integration apps against explicitly
maintained Electron releases on Linux, macOS, and Windows. They are scheduled separately from the every-PR E2E and
integration jobs.

## Configuration

`config.json` is the source of truth for four independent extension points:

- `environments`: CI operating systems, runner tags, images, and launch prefixes
- `targets`: named compatibility targets with open-ended `dimensions`; today the generator consumes the `electron`
  dimension
- `appTemplates`: fixture sources with open-ended `parameters`, variants, and execution modes
- `overrides`: ordered, committed file overlays selected by target and app template

`runtimeDependencyStrategy` is represented as a variant parameter. Every integration template currently has a
`default` variant that exercises plugin-owned dependency copying and a packaged-only `packager-copy` variant that
sets `copyRuntimeDependencies: false`. Each variant is materialized as its own application directory, so its build
output and package cannot mask another variant's result.

Variants are not limited to runtime dependency ownership. Their `parameters` object is deliberately open-ended, and
the generator exposes the merged template/variant parameters as `DD_ELECTRON_COMPATIBILITY_PARAMETERS` while building
the app. Add named environment mappings in the generator when a new parameter needs a convenient dedicated variable.

Versions are intentionally pinned. Updating an existing target is explicit and reviewable; adding a target does not
require duplicating a CI job because the child pipeline is generated from this file.

## Local usage

Generate and run every configured app for one target:

```sh
yarn test:compatibility:init electron-41
yarn test:compatibility electron-41
```

Generate only selected templates while developing:

```sh
yarn test:compatibility:init electron-41 --template minimal-e2e --template forge-webpack
yarn test:compatibility electron-41 --template minimal-e2e
yarn test:compatibility electron-41 --template forge-webpack --mode packaged
```

Selecting a template during initialization still generates all variants configured for that template. For example,
`--template forge-webpack` creates both `integration-apps/forge-webpack/default` and
`integration-apps/forge-webpack/packager-copy`. Test selectors then choose which generated application to run.

With no test selectors, `test:compatibility` runs the complete generated suite. Once `--template` is supplied, the
test command uses its `default` variant and every mode configured for that variant. Use `--variant` to select a
non-default variant and `--mode` to select one mode:

```sh
yarn test:compatibility electron-41 \
  --template electron-builder-vite \
  --variant packager-copy \
  --mode packaged
```

Each test selector can be specified at most once, and `--variant` and `--mode` require `--template`. Extra Playwright
arguments such as `--grep` and `--headed` continue to be forwarded. Playwright's native `--project` remains available
as an advanced exact-project selector, but it cannot be combined with the compatibility selectors. When generating
only selected templates, select only their corresponding templates during the test step.

By default, initialization packs the SDK from the current checkout, including uncommitted changes. To keep the
compatibility harness on the current checkout while packaging the SDK from a committed branch, tag, or SHA, use:

```sh
DD_ELECTRON_SDK_GIT_REF=my-sdk-branch yarn test:compatibility:init electron-41
# Equivalent local CLI option:
yarn test:compatibility:init electron-41 --sdk-ref my-sdk-branch
```

The SDK ref is checked out in an isolated temporary worktree; it does not change the harness checkout. A prebuilt SDK
tarball can instead be supplied with `--sdk-tarball <path>`. An explicit tarball takes precedence over the environment
variable, while `--sdk-tarball` and `--sdk-ref` cannot be passed together.

Generated apps install the packed SDK tarball and are written below `e2e/compatibility/generated/`, which is ignored
by Git. Integration variants live at `generated/<target>/integration-apps/<template>/<variant>`. Each Electron launch
asserts the exact configured runtime version before executing its scenarios.

## Generate the CI matrix locally

Preview the child pipeline generated from `config.json` with:

```sh
yarn test:compatibility:ci:generate
```

The command writes `e2e/compatibility/generated.gitlab-ci.yml`. This is a disposable, ignored artifact and should not
be committed. With no filters it contains every configured environment × target job.

Use comma-separated environment and target filters to generate a smaller matrix:

```sh
DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS=linux,macos \
DD_ELECTRON_COMPATIBILITY_TARGETS=electron-41,electron-44-prerelease \
yarn test:compatibility:ci:generate
```

Unknown identifiers and malformed lists fail generation with the available values. The filters affect CI generation
only; local `test:compatibility:init` and `test:compatibility` selection continues to use their CLI options.

## Scheduled CI

Create a GitLab pipeline schedule with `COMPATIBILITY_TESTS=true`. The parent pipeline generates one child job for
each configured environment × target. Within that job, all Playwright projects for the target run sequentially.
Electron nightly jobs are marked non-blocking through the target's `ci.allowFailure` setting.

When starting a pipeline in GitLab, the selected pipeline branch or tag supplies the compatibility harness. Set
`DD_ELECTRON_SDK_GIT_REF` only when the SDK should come from a different branch, tag, or commit. Manual and scheduled
pipeline variables are explicitly forwarded to the generated child pipeline.

The optional `DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS` and `DD_ELECTRON_COMPATIBILITY_TARGETS` pipeline variables use
the same comma-separated filters as local CI generation. They make it possible to introduce or diagnose the matrix in
stages without editing `config.json`. A typical rollout is:

1. `linux` with `electron-41`
2. `linux` with every target by leaving the target filter empty
3. `linux,macos` with `electron-41`, then with every target
4. `linux,macos,windows` with `electron-41`, then with every target

Leave both filters empty for the complete configured matrix.

The runner images must provide the repository-pinned Node and Yarn versions and support launching Electron desktop
applications. Linux additionally runs Electron under Xvfb.

## Version-specific app overrides

Use a committed override when a target cannot use a base app template unchanged, for example because an Electron API
or packager configuration differs. Override sources mirror paths inside the base template and contain only added or
replacement files:

```text
e2e/compatibility/overrides/electron-39/forge-webpack/src/main.ts
```

Register the overlay in `config.json`:

```json
{
  "id": "electron-39-forge-webpack",
  "when": {
    "targets": ["electron-39"],
    "templates": ["forge-webpack"]
  },
  "source": "e2e/compatibility/overrides/electron-39/forge-webpack",
  "remove": ["src/obsolete.ts"]
}
```

Matching overrides are applied in configuration order after the base template is copied. Each overlay adds or
replaces files, then its optional `remove` paths are deleted. Dependency rewriting, installation, and packaging happen
afterward. Generated apps remain disposable and should not be edited for changes that must run in CI.
