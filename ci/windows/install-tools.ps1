$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-SignedExecutable {
    param([string]$Url, [string]$Path, [string[]]$Arguments)
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
    if ((Get-AuthenticodeSignature $Path).Status -ne 'Valid') {
        throw "Invalid installer signature: $Path"
    }
    $installer = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
    if ($installer.ExitCode -notin @(0, 3010)) {
        throw "$Path failed with exit code $($installer.ExitCode)"
    }
    Remove-Item $Path
}

# Electron's native ZIP extractor needs this before yarn installs any Electron runtime.
Install-SignedExecutable -Url 'https://aka.ms/vc14/vc_redist.x64.exe' `
    -Path 'C:\vc_redist.x64.exe' -Arguments @('/install', '/quiet', '/norestart')

$nodeVersion = '25.9.0'
$nodeArchive = "node-v$nodeVersion-win-x64"
Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/$nodeArchive.zip" -OutFile C:\node.zip
$expectedHash = '929552b8305effac843ba7b4270c437aefb702fc3fbd73fcd1bffd35d4ac284e'
if ((Get-FileHash C:\node.zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Node archive checksum mismatch'
}
Expand-Archive C:\node.zip C:\
Move-Item "C:\$nodeArchive" C:\node
Remove-Item C:\node.zip

# Keep Corepack beside Node: the SDK's Windows command helper resolves its JS entry point here.
& npm.cmd install --global --prefix C:\node corepack@0.34.0
if ($LASTEXITCODE -ne 0) { throw 'Corepack installation failed' }
& corepack.cmd enable --install-directory C:\node
if ($LASTEXITCODE -ne 0) { throw 'Corepack enable failed' }
& corepack.cmd prepare yarn@4.17.1 --activate
if ($LASTEXITCODE -ne 0) { throw 'Yarn preparation failed' }

Install-SignedExecutable -Url 'https://github.com/git-for-windows/git/releases/download/v2.50.1.windows.1/Git-2.50.1-64-bit.exe' `
    -Path 'C:\git-install.exe' -Arguments @('/VERYSILENT', '/NORESTART', '/DIR="C:\Program Files\Git"')

Invoke-WebRequest -UseBasicParsing -Uri 'https://www.7-zip.org/a/7z2501-x64.exe' -OutFile C:\7z-install.exe
if ((Get-FileHash C:\7z-install.exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne '78afa2a1c773caf3cf7edf62f857d2a8a5da55fb0fff5da416074c0d28b2b55f') {
    throw '7-Zip installer checksum mismatch'
}
$sevenZip = Start-Process C:\7z-install.exe -ArgumentList '/S' -Wait -PassThru
if ($sevenZip.ExitCode -ne 0) { throw "7-Zip installation failed: $($sevenZip.ExitCode)" }
Remove-Item C:\7z-install.exe

New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
    -Name LongPathsEnabled -Value 1 -PropertyType DWord -Force | Out-Null
& git config --system core.longpaths true
if ($LASTEXITCODE -ne 0) { throw 'Git long-path configuration failed' }
& git config --system --add safe.directory C:/w
if ($LASTEXITCODE -ne 0) { throw 'Git workspace configuration failed' }

$actualNodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or $actualNodeVersion -ne 'v25.9.0') { throw 'Node validation failed' }
$actualCorepackVersion = & corepack.cmd --version
if ($LASTEXITCODE -ne 0 -or $actualCorepackVersion -ne '0.34.0') { throw 'Corepack validation failed' }
$actualYarnVersion = & yarn.cmd --version
if ($LASTEXITCODE -ne 0 -or $actualYarnVersion -ne '4.17.1') { throw 'Yarn validation failed' }
& npm.cmd --version
if ($LASTEXITCODE -ne 0) { throw 'npm validation failed' }

$longPathsEnabled = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem').LongPathsEnabled
if ($longPathsEnabled -ne 1) { throw 'Windows long-path support is not enabled' }
$gitLongPaths = & git config --system --get core.longpaths
if ($LASTEXITCODE -ne 0 -or $gitLongPaths -ne 'true') { throw 'Git long-path support is not enabled' }
exit 0
