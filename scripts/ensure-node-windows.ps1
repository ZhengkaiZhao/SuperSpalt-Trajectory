param(
    [Version]$MinimumVersion = '22.0.0',
    [Version]$RecommendedVersion,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
if ($env:SUPERSPLAT_NODE_NONINTERACTIVE -eq '1') { $NonInteractive = $true }
$recommendedFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.nvmrc'
if (-not $RecommendedVersion) {
    $RecommendedVersion = [Version](Get-Content -LiteralPath $recommendedFile -Raw).Trim()
}

function Read-NodeVersion([string]$NodePath) {
    if (-not $NodePath) { return $null }
    $text = (& $NodePath -p 'process.versions.node' 2>$null).Trim()
    if (-not $text) { return $null }
    return [Version]$text
}

function Find-Node {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' }),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

    return $candidates | ForEach-Object {
        $version = Read-NodeVersion $_
        [PSCustomObject]@{
            Path = $_
            Version = $version
            Preferred = $version -and $version.Major -eq $RecommendedVersion.Major
        }
    } | Where-Object Version |
        Sort-Object @{ Expression = 'Preferred'; Descending = $true }, @{ Expression = 'Version'; Descending = $true } |
        Select-Object -ExpandProperty Path -First 1
}

Write-Host '============================================================'
Write-Host ' SuperSpalt Trajectory - Node.js environment check'
Write-Host '============================================================'

$nodePath = Find-Node
$currentVersion = Read-NodeVersion $nodePath
if ($nodePath) { $env:SUPERSPLAT_NODE_EXE = $nodePath }
Write-Host ("[Node] Installed : {0}" -f $(if ($currentVersion) { "v$currentVersion ($nodePath)" } else { 'not found' }))
Write-Host "[Node] Minimum   : v$MinimumVersion (supported LTS line)"
Write-Host "[Node] Recommended: v$RecommendedVersion LTS"

$belowMinimum = -not $currentVersion -or $currentVersion -lt $MinimumVersion
$belowRecommended = -not $currentVersion -or $currentVersion -lt $RecommendedVersion
if (-not $belowRecommended) {
    Write-Host '[Node] Status    : ready' -ForegroundColor Green
    return
}

$reason = if ($belowMinimum) {
    'Node.js is missing or unsupported and must be installed/upgraded.'
} else {
    'Node.js is supported, but a newer project-tested LTS patch is available.'
}
Write-Host "[Node] Status    : $reason" -ForegroundColor Yellow

if ($NonInteractive) {
    if ($belowMinimum) {
        Write-Error "Node.js v$MinimumVersion or newer is required. Download: https://nodejs.org/en/download"
    }
    Write-Host '[Node] Non-interactive check: continuing with the installed supported version.' -ForegroundColor Yellow
    return
}

$answer = Read-Host 'Install/upgrade Node.js LTS with winget now? [Y/n]'
if ($answer -and $answer -notmatch '^[Yy]') {
    if ($belowMinimum) {
        Write-Error "Node.js v$MinimumVersion or newer is required. Download: https://nodejs.org/en/download"
    }
    Write-Host '[Node] Continuing with the installed supported version.' -ForegroundColor Yellow
    return
}

if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Write-Error 'winget is unavailable. Install the current Node.js LTS from https://nodejs.org/en/download'
}

$packageInstalled = winget list --id OpenJS.NodeJS.LTS --exact --accept-source-agreements |
    Select-String 'OpenJS.NodeJS.LTS' -Quiet
$operation = if ($packageInstalled) { 'upgrade' } else { 'install' }
Write-Host "[Node] Running winget $operation OpenJS.NodeJS.LTS..." -ForegroundColor Cyan
& winget $operation --id OpenJS.NodeJS.LTS --exact `
    --accept-package-agreements --accept-source-agreements
if ($LASTEXITCODE -ne 0) {
    Write-Error "winget failed with exit code $LASTEXITCODE. You can install Node.js manually from https://nodejs.org/en/download"
}

$nodePath = Find-Node
$currentVersion = Read-NodeVersion $nodePath
if (-not $currentVersion -or $currentVersion -lt $MinimumVersion) {
    Write-Error 'Node.js was installed but is not visible yet. Close this window and run the launcher again.'
}

$env:SUPERSPLAT_NODE_EXE = $nodePath
Write-Host "[Node] Ready     : v$currentVersion" -ForegroundColor Green
