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

Write-Host 'Checking Node startup...'
Invoke-Node -NodeArguments @('--version')
Write-Host 'Starting the Windows test preparation script...'
Invoke-Node -NodeArguments @('C:/source/scripts/run-windows-container-tests.ts')
exit 0
