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
        'run', '--rm', '--name', $containerName, '--isolation', $Isolation, '--memory', $Memory,
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
    & docker rm --force $containerName 2>$null | Out-Null
    & docker image rm --no-prune $imageTag 2>$null | Out-Null
    Write-Host "Windows test artifacts: $artifacts"
}

exit 0
