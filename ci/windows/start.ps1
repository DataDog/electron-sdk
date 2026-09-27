# Start through PowerShell so native Node failures still leave a diagnostic message.
$ErrorActionPreference = 'Stop'
Write-Host "Windows test container started. OS: $([Environment]::OSVersion.VersionString)"

function Invoke-Node {
    param([string[]]$NodeArguments)
    # Native stderr is not itself a failure in Windows PowerShell 5.1.
    $ErrorActionPreference = 'Continue'
    & C:/node/node.exe @NodeArguments
    $nativeExitCode = $LASTEXITCODE
    if ($nativeExitCode -ne 0) {
        $hexCode = '{0:X8}' -f ($nativeExitCode -band 0xFFFFFFFFL)
        Write-Host "Node exited with code $nativeExitCode (0x$hexCode)."
        exit $nativeExitCode
    }
}

# Record the runtime actually installed by the floating VC++ installer URL.
# Diagnostics must not change whether the baseline starts or how Electron is launched.
try {
    $runtime = [ordered]@{
        WindowsBuild = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' |
            Select-Object CurrentBuild, UBR, BuildLabEx
        VisualCpp = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' |
            Select-Object Version, Installed
        RuntimeDlls = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'ucrtbase.dll') | ForEach-Object {
            $file = Get-Item (Join-Path $env:SystemRoot "System32\$_")
            [ordered]@{ Path = $file.FullName; Version = $file.VersionInfo.FileVersion; Sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash }
        }
    }
    $json = $runtime | ConvertTo-Json -Depth 5
    $json | Set-Content -Encoding UTF8 C:/artifacts/container-system.json
    Write-Host "Container runtime versions: $json"
} catch {
    Write-Warning "Could not collect container runtime versions: $_"
}

Write-Host 'Checking Node startup...'
Invoke-Node -NodeArguments @('--version')
Write-Host 'Starting the Windows test preparation script...'
Invoke-Node -NodeArguments @('C:/source/scripts/run-windows-container-tests.ts')
exit 0
