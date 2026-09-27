[CmdletBinding()]
param(
    [ValidateSet('compatibility', 'e2e', 'integration')]
    [string]$Suite = 'compatibility',
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]*$')]
    [string]$Target = 'electron-41',
    [ValidateSet('process', 'hyperv')]
    [string]$Isolation = 'process',
    [string]$Memory = '8g'
)

$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runId = if ($env:CI_JOB_ID) { $env:CI_JOB_ID } else { [Guid]::NewGuid().ToString('N') }
$containerName = "electron-sdk-tests-$runId"
$imageTag = "electron-sdk-windows-tests:$runId"
$artifacts = Join-Path $checkout "windows-test-artifacts\$Suite-$Target-$runId"
New-Item -ItemType Directory -Force $artifacts | Out-Null

function Invoke-DockerLogged {
    param([string[]]$DockerArguments, [string]$LogName)
    # PowerShell 5.1 can treat ordinary native stderr output as a terminating error.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker @DockerArguments 2>&1 | Tee-Object -FilePath (Join-Path $artifacts $LogName)
        $nativeExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($nativeExitCode -ne 0) {
        throw "docker $($DockerArguments[0]) failed with exit code $nativeExitCode. See $artifacts\$LogName"
    }
}

# These probes report evidence, not a verdict on nested virtualization support.
# A denied or unavailable probe must not prevent the tests from running.
function Get-HostDiagnostic {
    param([scriptblock]$Probe)
    $ErrorActionPreference = 'Stop'
    try {
        $value = & $Probe
        return @{ Status = 'collected'; Value = $value }
    } catch {
        return @{ Status = 'unavailable'; Error = $_.Exception.Message; ErrorId = $_.FullyQualifiedErrorId }
    }
}

function Save-HostDiagnostics {
    try {
        $diagnostics = [ordered]@{
            Time = [DateTime]::UtcNow.ToString('o')
            RequestedIsolation = $Isolation
            RequestedMemory = $Memory
            PowerShellVersion = $PSVersionTable.PSVersion.ToString()
            Docker = Get-HostDiagnostic {
                $info = & docker info --format '{{json .}}' 2>$null
                if ($LASTEXITCODE -ne 0) { throw "docker info failed with exit code $LASTEXITCODE" }
                $info | ConvertFrom-Json | Select-Object ServerVersion, OperatingSystem, KernelVersion, OSType, Architecture, Isolation, NCPU, MemTotal
            }
            Windows = Get-HostDiagnostic {
                Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 10 |
                    Select-Object Caption, Version, BuildNumber, OSArchitecture
            }
            Computer = Get-HostDiagnostic {
                Get-CimInstance Win32_ComputerSystem -OperationTimeoutSec 10 |
                    Select-Object Manufacturer, Model, HypervisorPresent
            }
            Processors = Get-HostDiagnostic {
                Get-CimInstance Win32_Processor -OperationTimeoutSec 10 |
                    Select-Object Name, VirtualizationFirmwareEnabled, VMMonitorModeExtensions, SecondLevelAddressTranslationExtensions
            }
            HyperVFeatures = Get-HostDiagnostic {
                Get-WindowsOptionalFeature -Online -FeatureName '*Hyper-V*' |
                    Select-Object FeatureName, @{ Name = 'State'; Expression = { $_.State.ToString() } }
            }
        }
        $diagnostics | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $artifacts 'host-diagnostics.json')
        Write-Host "Requested container isolation: $Isolation; memory: $Memory. Host probes saved to host-diagnostics.json."
    } catch {
        Write-Warning "Could not save host diagnostics: $_"
    }
}

Save-HostDiagnostics

$dockerOs = & docker info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0) { throw 'Cannot connect to the Docker daemon' }
if ($dockerOs.Trim() -ne 'windows') { throw 'This test requires a Windows Docker daemon' }
if (-not (Test-Path (Join-Path $checkout '.git') -PathType Container)) {
    throw 'Use a regular Git clone for this experiment; linked worktrees refer to files outside the container mount.'
}

try {
    Invoke-DockerLogged -DockerArguments @(
        'build', '--isolation', $Isolation, '--memory', $Memory,
        '--tag', $imageTag, $PSScriptRoot
    ) -LogName '00-image-build.log'

    $dockerArguments = @(
        'run', '--name', $containerName, '--isolation', $Isolation, '--memory', $Memory,
        '--mount', "type=bind,source=$checkout,target=C:\source,readonly",
        '--mount', "type=bind,source=$artifacts,target=C:\artifacts",
        '--env', "DD_ELECTRON_TEST_SUITE=$Suite", '--env', "DD_ELECTRON_COMPATIBILITY_TARGET=$Target",
        '--env', 'DEBUG='
    )
    # Pass only the settings needed by this job, rather than the runner's complete environment.
    foreach ($name in @('CI', 'DD_ELECTRON_SDK_GIT_REF', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')) {
        if (Test-Path "Env:$name") { $dockerArguments += @('--env', $name) }
    }
    Invoke-DockerLogged -DockerArguments ($dockerArguments + @($imageTag)) -LogName 'container.log'
} finally {
    # Remove only resources created by this invocation; never prune the shared daemon.
    $ErrorActionPreference = 'Continue'
    # Keep the stopped container until diagnostics are saved. Its exit code distinguishes a
    # process failure inside the container from a failure of the host Docker client.
    try {
        $state = & docker inspect --format '{{json .State}}' $containerName 2>$null
        if ($LASTEXITCODE -eq 0) {
            $state | Set-Content -Encoding UTF8 (Join-Path $artifacts 'container-state.json')
            Write-Host "Container state: $state"
            & docker logs $containerName 2>&1 | Out-File -Encoding UTF8 (Join-Path $artifacts 'container-output.log')
        }
    } catch {
        Write-Warning "Could not collect container diagnostics: $_"
    }
    # Read selected metadata before cleanup, without including environment variables or credentials.
    foreach ($diagnostic in @(
        @{
            File = 'container-runtime.json'
            Target = $containerName
            Properties = @(
                @{ Name = 'Isolation'; Expression = { $_.HostConfig.Isolation } },
                @{ Name = 'MemoryBytes'; Expression = { $_.HostConfig.Memory } },
                @{ Name = 'ImageId'; Expression = { $_.Image } }
            )
        },
        @{
            File = 'image-runtime.json'
            Target = $imageTag
            Properties = @('Id', 'OsVersion', 'Architecture')
        }
    )) {
        try {
            $inspection = & docker inspect --format '{{json .}}' $diagnostic.Target 2>$null
            if ($LASTEXITCODE -eq 0) {
                $metadata = $inspection | ConvertFrom-Json | Select-Object -Property $diagnostic.Properties | ConvertTo-Json -Compress
                $metadata | Set-Content -Encoding UTF8 (Join-Path $artifacts $diagnostic.File)
                Write-Host "$($diagnostic.File): $metadata"
            } else {
                Write-Warning "Could not inspect $($diagnostic.Target) for $($diagnostic.File); docker exit code $LASTEXITCODE"
            }
        } catch {
            Write-Warning "Could not save $($diagnostic.File): $_"
        }
    }
    & docker rm --force $containerName 2>$null | Out-Null
    & docker image rm --no-prune $imageTag 2>$null | Out-Null
    Write-Host "Windows test artifacts: $artifacts"
}

exit 0
