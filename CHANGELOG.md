# Changelog

All notable changes to `@datadog/electron-sdk` are documented here.

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
