# Changelog

All notable changes to `@datadog/electron-sdk` are documented here.

## [0.6.0] - 2026-07-16

### ✨ Features

- ✨ [RUM-16632] add browser profiling support (#168)
- ✨ [RUM-17020] move Electron IPC and net instrumentation from dd-trace into the SDK (#152)

### 🐛 Bug Fixes

- 🐛 [RUM-17016] register bridge-config responder at instrument time (#170)

### Internal

- Documentation fixes (#169)
- refactor(tools): use shared createDisplay util from js-core (#160)
- 👷 Update all non-major dependencies (minor/patch) (#153)
- 👷 Update dependency concurrently to v10 (#155)

## [0.5.0] - 2026-06-30

### ✨ Features

- [RUM-15525] Add `sessionSampleRate` configuration option (#139)

### 🐛 Bug Fixes

- 🐛 fix missing fields on main-process RUM events and intake requests (#157)

### 📝 Documentation

- 📝 Update PR template and copilot instructions
- 📝 improve copilot review comment structure (#143)
- 📝 add code review guide for agents (#141)

### Internal

- ⬆️ update browser-sdk to 7.4.0 and js-core to 0.0.4 (#145)
- 👷 Update dependency eslint-plugin-unicorn to v68 (#156)
- 👷 Update actions/checkout action to v7 (#154)
- 👷 fix typecheck for unbuilt json-schema-to-typescript fork (#148)
- 👷 exclude worktree directories from linting and formatting (#147)
- 👷 Update all non-major dependencies (minor/patch) (#120)
- 👷 Update dependency lint-staged to v17 (#128)
- ♻️ split Assembly into MainAssembly and RendererPipeline (#133)
- ♻️ replace time imports from browser-core with js-core/time (#138)
- [RUM-16912] Refactor transport layer for extensibility (#140)

## [0.4.0] - 2026-06-17

### ✨ Features

- ✨ [RUM-16444] always create a new session on app launch (#130)

### Internal

- 👷 Bump dd-trace to 5.109.0 (#136)
- 👷 playground improvements: RUM Explorer button and Playwright test infra (#98)
- ♻️ replace dateNow from @datadog/browser-core with @datadog/js-core/time (#132)

## [0.3.0] - 2026-05-27

### ✨ Features

- [RUM-15104] Add main-process resource tracking and tracing via `dd-trace` integration (#95). Preload injection is now handled by `dd-trace` instead of the SDK's `registerPreload()`, and new bundler plugins (`DatadogWebpackPlugin`, `datadogVitePlugin`, `datadogEsbuildPlugin`) are provided for Vite, Webpack, and esbuild.

### 🐛 Bug Fixes

- 🐛 fix crash source_type mapping (#127)

### ⚠️ Breaking Changes

- The old `registerPreload()` (which deferred `session.registerPreloadScript()` to `app.whenReady()`) and the bundled `preload-auto.cjs` bridge have been removed. dd-trace wraps `BrowserWindow` at require-time to inject its own preload script automatically.
- Apps must import `@datadog/electron-sdk/instrument` before `electron` — either directly in the main entry file (e.g. `import '@datadog/electron-sdk/instrument'` as the first import in `main.ts`), or via one of the new bundler plugins which prepend dd-trace initialization as a banner.
- When using **Vite**, **Webpack**, or **esbuild**, the corresponding bundler plugin is mandatory. These plugins ensure dd-trace and `@datadog/electron-sdk` are externalized and correctly initialized before application code runs.
- For **ESM output** (esbuild/vite with `format: "esm"`), the bundler plugins register dd-trace's preload script directly via `session.defaultSession.registerPreloadScript()` on `app.ready`, since ESM's two-phase module loading prevents dd-trace's `BrowserWindow` wrapping from taking effect.

### Internal

- 👷 Update dependency eslint-plugin-unicorn to v64 (#122)
- 👷 Update actions/checkout action to v6 (#118)
- 👷 Update actions/setup-node action to v6 (#119)
- 👷: migrate Renovate config (#117)
- 👷 Update dependency webpack to v5.104.1 [SECURITY] (#115)

## [0.2.0] - 2026-05-04

### ✨ Features

- ⚗️ [RUM-15521] add RUM Operations API to the main process (#102)

### 🐛 Bug Fixes

- 🐛 recover orphaned .tmp batch files on init (#104)
- 🐛 [RUM-15689] fix view date to use start time instead of update time (#97)

### Internal

- ✅ [RUM-15484] bootstrap integration test infrastructure (#91)
- 🔥 remove `_generateActivity` and clean up e2e infrastructure (#90)
- 👷 Update dependency electron to v41.1.0 [SECURITY] (#110)
- 👷 Update dependency vite to v8.0.5 [SECURITY] (#109)
- 👷 Configure Renovate (#92)
- 👷 fix renovate config and integration app yarn version (#112)
- 👷 skip lockfile updates for integration apps in renovate (#113)
- 👷 restore integration apps yarn.lock after packaging (#114)
- 👷 [RUM-15055] fix npm publish OIDC auth after v0.1.3 (#89)

## [0.1.3] - 2026-04-08

### Internal

- 👷 [RUM-15055] fix release / publish pipeline issues from v0.1.2 (#87)

## [0.1.2] - 2026-04-07

### Internal

- 👷 [RUM-15055] fix publish pipeline issues from v0.1.1 (#81)

## [0.1.1] - 2026-04-02

### 🐛 Bug Fixes

- 🐛 fix session management and event attribution issues (#79)
- 🐛 [RUM-15336] Fix preload script resolution (#73)

### Internal

- 👷 [RUM-15055] fix release/publish pipeline issues from v0.1.0 (#77)
- ♻️ move browser-core to devDependencies (#78)
- ♻️ chore: re-enable dependabot with 2-day cooldown (#64)

## [0.1.0] - 2026-03-26

### ✨ Features

- ✨ [RUM-14998] IPC Renderer process support (#38)
- ✨ [RUM-14260] add native crash reporting (#37)
- ✨ [RUM-14514] support session and view attribution by event startTime (#36)
- ✨ [RUM-14243] Implement transport layer & batch management (#19)
- ✨ [RUM-15003] attach user-agent header to intake requests (#35)
- ✨ [RUM-14259] Add RUM error collection (#23)
- ✨ [RUM-14340] attach sdk version to events (#24)
- ✨ [RUM-14582] track view counters (#21)
- ✨ [RUM-14242] Introduce event bus pattern for data processing (#6)
- ✨ [RUM-14582] Initiate view collection (#20)
- ✨ [RUM-14241] Implement Assembly with Hooks system (#11)
- ✨ [RUM-14244] bootstrap SDK telemetry (#9)
- ✨ [RUM-14240] Add session manager (#3)

### Internal

- 👷 [RUM-15055] configure and verify npm package content (#61)
- 👷 [RUM-15055] add release / publish pipeline (#56)
- 👷 [RUM-14260] add rust license tracking (#57)
- 👷 Setup PR / Issue templates (#4)
- Setup basic e2e scenario
- Setup playground
- Setup CI
- Add license files + check
- Init project + node + yarn
