# Changelog

All notable changes to `@datadog/electron-sdk` are documented here.

## [1.0.0] - 2026-10-29

This is the first generally available release. It turns on execution context tracking for everyone, rewrites app paths to be root-relative so stack traces resolve with uploaded source maps, and adds a tracking consent API.

**Migrating from 0.x:**

- **Await `init()` before creating windows** (#263): a window opened before `init()` resolves doesn't send its page events until it is reloaded. If you delay `init()` until the end user consents, call it at startup with `trackingConsent: 'pending'` instead (see [Tracking Consent](https://github.com/DataDog/electron-sdk/blob/v1.0.0/README.md#tracking-consent)).
- **The `main process` view is replaced by execution contexts** (#262): main-process data is no longer attached to the `main process` view (`electron://main-process`). Update any dashboard, monitor or query that filters on that view to use `@execution_context.type:main-process` instead.
- **App paths are root-relative** (#241): the app path (and its resolved realpath) is replaced with `/` in every payload. View and resource URLs, error stacks, logs, spans, replay `href` and profile resources now carry paths relative to the app root: `file:///Users/alice/…/app.asar/dist/renderer/index.js` becomes `/dist/renderer/index.js`. Update queries and monitors that match the old values. Error Tracking issues from frames under the app path are regrouped once. To get readable stacks, [upload your source maps](https://github.com/DataDog/electron-sdk/blob/v1.0.0/README.md#source-maps). Other paths stay absolute, such as `app.asar.unpacked` (native modules) and the `userData` and `crashDumps` folders. `beforeSendRum` still receives the original paths, so rewrites you already have keep working.
- **Main-process IPC spans are removed** (#259): `electron.main.receive`, `electron.main.handle` and `electron.main.send` are no longer emitted, and HTTP spans issued from IPC handlers are now root spans. `traceSamplingRules` that match `electron.main.*` or IPC channel names no longer match anything. Target `http.request` spans instead, for example `{ tags: { 'http.url': '*/health' }, sampleRate: 0 }`.
- **Bundler plugins no longer copy runtime dependencies by default** (#216): `copyRuntimeDependencies` now defaults to `false`, and your packager must include `@datadog/electron-sdk` and `dd-trace` in the app. If you use Electron Forge's Vite or Webpack plugin, update `packagerConfig.ignore` as described in [Electron Forge](https://github.com/DataDog/electron-sdk/blob/v1.0.0/README.md#electron-forge). If your packager can't include them, set `copyRuntimeDependencies: true` as a best-effort fallback.

### 💥 Breaking Changes

- 💥 [RUM-19119] drop the events of pages loaded before init() resolves (#263)
- 💥 [RUM-18606] enable execution context by default (#262)
- 💥 [RUM-17990] scrub the app path from payloads (#241)
- 💥 [RUM-18777] remove main-process IPC tracing (#259)
- 💥 [RUM-18428] stop copying runtime dependencies by default in bundler plugins (#216)

### ✨ Features

- ✨ accept any datadog site (#275)
- ✨ Expose the tracking consent API (#257)
- ✨ [RUM-17990] add a path scrubber for serialized payloads (#240)
- ✨ Apply tracking consent to spans and profiles (#247)
- ✨ Apply tracking consent to the session lifecycle (#234)
- ✨ Persist tracking consent for crash recovery (#233)
- ✨ Add consent-aware batch storage (#225)

### 🐛 Bug Fixes

- 🐛 validate operation context and description types (#274)
- 🐛 [RUM-18606] create sessions started while a bridged page stays open (#264)
- 🐛 finish net.request spans on response (#258)
- 🐛 [RUM-18947] accept renderer logs with non-string message or status (#245)

### 📝 Documentation

- 📝 [RUM-17990] document source map upload for electron apps (#253)
- 📝 refresh review guide and coding conventions (#254)

### Internal

- 👷 Update dependency eslint-plugin-unicorn to v78 (#270)
- 👷 Update dependency vite to v8 [SECURITY] (#273)
- 👷 Update dependency electron-vite to v6 (#269)
- 👷 Lock file maintenance (#191)
- 👷 Update dependency @electron/get to v5 (#243)
- 👷 Update dependency vitest to v4.1.11 [SECURITY] (#218)
- 👷 Update dependency vite to v8.1.6 [SECURITY] (#261)
- 👷 [RUM-17990] playground fixes for source map validation (#250)
- 👷 [EENG-7150] Use slack-notifier v3-sdm template image (#246)
- 👷 Update dependency eslint-plugin-unicorn to v76 (#228)
- 👷 [RUM-17990] add playground source map upload tooling (#237)
- 👷 [RUM-18686] Electron OS and Version testing [windows] (#229)

## [0.10.0] - 2026-09-30

### ✨ Features

- ✨ add global context to the main process (#192)

### 🐛 Bug Fixes

- 🐛 [RUM-18683] Fix view timestamp race and stabilize session renewal tests (#226)

### Internal

- 👷 [RUM-15522] Electron OS & Version testing [linux, macos] (#204)
- ⚗️ [RUM-17561] add execution context tracking for main and renderer processes (#209)
- ⚗️ [RUM-18548] Compute execution context name (#222)
- ⚗️ Add internal tracking consent state (#224)
- ♻️ split RumEvent into RendererRumEvent and MainRumEvent (#207)

## [0.9.0] - 2026-09-14

### ✨ Features

- ✨ forward logs from the renderer process (#212)
- ✨ add beforeSend event filtering and scrubbing (#180)
- ✨ support telemetry from the renderer process (#205)
- ✨ add trace sampling rules (#199)
- ✨ add the `traceSampleRate` fallback configuration option (#193)
- ✨ [RUM-17988] tag main-process errors with error.source_type: nodejs (#206)
- ✨ report configuration and usage telemetry (#195)

### 🐛 Bug Fixes

- 🐛 carry `batchSize` and `uploadFrequency` into the resolved configuration (#198)

### Internal

- 👷 Update dependency eslint-plugin-unicorn to v74 (#214)
- 👷 Update dependency jsdom to v30 (#215)
- Migrate SAST config to code-security.datadog.yaml (#210)
- 🚀 Cancel stale CI pipelines (#211)
- 👷 Update dependency eslint-plugin-unicorn to v73 (#201)
- 👷 Update dependency @electron/asar to v4 (#200)
- ♻️ type intake event bodies by their event type (#202)

## [0.8.1] - 2026-08-11

### Internal

- ⬆️ upgrade dd-trace to 6.10.0 (#196)

## [0.8.0] - 2026-08-06

### 💥 Breaking Changes

- 💥 [RUM-17543] rename allowedWebViewHosts → allowedRendererHosts and enforce host filtering (#181)

`allowedWebViewHosts` renamed to `allowedRendererHosts` and is now **required**. Configure which renderer hosts are allowed to send data to the electron-sdk, see [documentation](https://github.com/DataDog/electron-sdk/#allowedrendererhosts-values).

Add `allowedRendererHosts: ['*']` to your init() call to preserve previous behavior.

### ✨ Features

- ✨ [RUM-15529] Integrate Session Replay (#131)
- ✨ Add configurable runtime dependency copying (#182)

## [0.7.0] - 2026-07-30

### ✨ Features

- ✨ add custom duration vitals to the main process (#172)
- ✨ [RUM-15788] Add User & Account info (#135)
- ✨ cap pending batch files with drop-oldest eviction (#173)

### 🐛 Bug Fixes

- 🐛 stop including the bridge payload in telemetry errors (#185)
- 🐛 make session expiration idempotent (#183)

### Internal

- 👷 consolidate safe Renovate updates (#187)

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
