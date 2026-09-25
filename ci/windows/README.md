# Electron tests in a Windows container

This uses the shared `windows-v2:2022` runner and a full Windows Server 2022 container. The runner
only needs Git, PowerShell and access to its Windows Docker daemon. Node, Yarn, the VC++ runtime,
Git and 7-Zip are installed in the test image. Dependency installation, fixture packaging and
Playwright execution all happen inside the container.

The September 24 experiment successfully created an Electron window, exercised renderer-to-main
IPC and captured a screenshot with `mcr.microsoft.com/windows/server:ltsc2022`. Server Core failed
when creating the window. The full suites also ran in the Server container, although those runs
reused dependencies and apps prepared on the host. This workflow still needs a Windows CI run to
validate preparation from scratch.

Microsoft documents the [Windows Server base image's API coverage](https://learn.microsoft.com/en-us/virtualization/windowscontainers/manage-containers/container-base-images).
The [official Playwright Docker image](https://playwright.dev/docs/docker) is a Linux image; it would
test Linux Electron rather than the Windows runtime needed here.

## Run locally

Use a normal clone of **electron-sdk** containing these changes. No other repository, host Node
installation or prepared test apps are needed. On Windows Desktop, switch Docker Desktop to
Windows containers first. Allow plenty of disk space: the earlier prepared checkout alone used
about 28 GB, in addition to the Windows image and container layers.

From PowerShell in the repository root:

```powershell
docker info --format '{{.OSType}}' # Must print windows
powershell -NoProfile -ExecutionPolicy Bypass -File ci/windows/run.ps1 -Target electron-41
```

The default is process isolation, matching the shared Server 2022 runner. On a local host that
requires Hyper-V isolation, pass `-Isolation hyperv`; Hyper-V must already be available. Consult
the [Windows container compatibility table](https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/version-compatibility)
for supported host/image combinations. The script does not install Docker or change host features.

Run the regular suites separately if needed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ci/windows/run.ps1 -Suite e2e
powershell -NoProfile -ExecutionPolicy Bypass -File ci/windows/run.ps1 -Suite integration
```

Each invocation builds the toolchain image using Docker's layer cache, copies the current source
(including local edits) to `C:\w` inside a fresh container, and prepares the selected suite there.
Host dependencies and generated apps are excluded. Keeping preparation and execution at the same
short container path avoids stale Yarn links and reduces Windows path-length problems. Linked Git
worktrees are not supported by this runner because their Git metadata points outside the mount.

The script writes logs, environment details, compatibility metadata, Playwright results and HTML
reports under `windows-test-artifacts/<suite>-<target>-<run-id>/`. Reports depend on the selected
Playwright reporter; CI enables HTML reports. Artifacts survive a failed suite. The script returns
a failure when the image build, installation, packaging or tests fail. It removes only its own
container and image tag, leaving reusable build layers on the daemon.

## CI

Generate a compatibility pipeline with `COMPATIBILITY_TESTS=true`,
`DD_ELECTRON_COMPATIBILITY_ENVIRONMENTS=windows` and
`DD_ELECTRON_COMPATIBILITY_TARGETS=electron-41` for the first trial. Windows jobs call this same
script on `windows-v2:2022`, with `OVERRIDE_GIT_STRATEGY=clone`. Linux and macOS keep their existing
execution paths. No registry publishing, dedicated AMI, autoscaling group or Docker socket inside
the test container is needed: Playwright and Electron run together in one container.

`DD_ELECTRON_SDK_GIT_REF` is forwarded when set. If it requires fetching private refs or submodules,
Git needs suitable credentials inside the container; host SSH agents and credential helpers are
not automatically available. Start with the default, which packages the current checkout.

## Interpreting failures

If the container stops before the suites start, check `container.log` for the last startup marker:
PowerShell startup, Node startup, source copying or toolchain validation. Before cleanup, the runner
also saves `container-state.json` (Docker's process exit code and error) and `container-output.log`
(output retained by Docker). These help distinguish a Docker client failure from a container process
failure. They may be absent if Docker could not create or inspect the container. Diagnostic collection
is best effort and does not change the job result.

- A container may report zero attached displays even when Playwright can interact with Electron
  windows. The telemetry test compares the reported count with Electron's actual display count.
- Crash tests previously selected the first error after restart. An unrelated startup error could
  arrive before crash processing and produce `is_crash: undefined` or an unexpected session ID.
  They now wait specifically for a crash event and retain the session, stack and context assertions.
  A missing crash event still fails. The earlier native Windows failures mean we still need to
  verify crash handling with each Electron version; this change does not establish that it works.
- GPU fallback warnings alone did not prevent the smoke test from passing. Test assertions and the
  process exit code determine success; the runner does not suppress failures or increase retries.

This establishes a functional test environment. Overhead measurements need a separate baseline:
container resource limits, software rendering and GPU fallback may differ from a desktop app.
