param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [string]$Archive,

    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
    throw "Expected Windows PowerShell 5.1, received $($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)."
}

Compress-Archive -Path (Join-Path $Source '*') -DestinationPath $Archive -CompressionLevel Fastest
Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
