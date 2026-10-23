# Windows compatibility tests

Windows jobs use the shared `windows-v2:2022` runner to build and run a Windows Server 2022
container. The host needs Git, PowerShell, and a Windows Docker daemon. The image installs Node,
Corepack, Yarn, Git, 7-Zip, and the Visual C++ runtime; Node and Yarn must match `package.json`.

`ci/windows/run.ps1` mounts the checkout read-only and starts the container. Inside it,
`scripts/run-windows-container-tests.ts` copies sources and Git metadata to `C:\w`, installs
dependencies, prepares the apps, and runs Playwright. Host dependencies and generated apps are
excluded. Preparation and testing use the same short path, with async workspace copying to avoid
the native crash observed with synchronous copying on Windows.

## Run locally

Use a regular Git clone; linked worktrees refer to Git metadata outside the container mount.
Allow sufficient disk space for the Windows image and generated apps.

```powershell
docker info --format '{{.OSType}}' # Must print windows
powershell -NoProfile -ExecutionPolicy Bypass -File ci/windows/run.ps1 -Target electron-41
```

Process isolation is the default on the Server 2022 runner. Use `-Isolation hyperv` if your host
requires and supports it. The script does not configure the host. Use `-Suite e2e` or
`-Suite integration` to run a regular suite instead of compatibility tests.

## CI and artifacts

Windows participates in the compatibility matrix on default-branch pushes, including PR merges.
For a focused manual pipeline, set `COMPATIBILITY_TESTS=true`,
`DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS=windows`, and
`DD_ELECTRON_COMPATIBILITY_TARGETS=electron-41`.

Each invocation builds an image locally, creates a unique container and image tag, and removes only
those resources. It never prunes the shared Docker daemon. No dedicated AMI or published image is
required.

Command logs, container state, environment details, compatibility metadata, and available Playwright
reports and traces are saved under `windows-test-artifacts/<suite>-<target>-<run-id>/`, including on
failure. Tests use two retries in CI and no retries locally. Windows retains traces for failed
attempts, prints errors immediately, and stops after three failures. A 20-second Electron launch
timeout leaves time to report launch errors within the 30-second test timeout.

## Coverage and constraints

The suite exercises both packaged dependency-copy variants and crash reporting across restart.
Validate changes on Windows, Linux, and macOS because preparation and test helpers are shared.

Display telemetry is checked against Electron's actual display count, which can be zero in a
container. The Windows payload regression checks packager-copy Vite output using a PowerShell 5.1
archive/extraction round trip below the legacy path limit. This workflow uses the full Windows Server
image, not Server Core. Use it for functional tests; performance measurements need a separate baseline.
