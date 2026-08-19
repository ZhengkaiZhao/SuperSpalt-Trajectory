param(
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$buildFile = Join-Path $repoRoot 'dist\index.js'
$rtxProfile = Join-Path $env:LOCALAPPDATA 'SuperSplat-Diagnose-Chrome'

# Chrome persists the previous app-window placement. If the last session was
# minimized, it can reopen at Windows' hidden (-25600, -25600) coordinates.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SuperSplatWindow {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

function Show-SuperSplatWindow([object]$ProcessInfo) {
    if (-not $ProcessInfo) { return $false }
    $process = Get-Process -Id $ProcessInfo.ProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.MainWindowHandle -eq 0) { return $false }
    [SuperSplatWindow]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
    [SuperSplatWindow]::ShowWindow($process.MainWindowHandle, 3) | Out-Null
    [SuperSplatWindow]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
    return $true
}

$profileAppProcesses = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object {
        $_.CommandLine -like "*--user-data-dir=$rtxProfile*" -and
        $_.CommandLine -like '*--app=*'
    })

# Fast reopen: before checking Node.js or scanning project state, restore the
# app when its build stamp matches and its local server is still responding.
if (-not $Restart -and (Test-Path -LiteralPath $buildFile)) {
    $fastBuildStamp = (Get-Item -LiteralPath $buildFile).LastWriteTimeUtc.Ticks
    $fastAppUrl = "http://localhost:3011/?build=$fastBuildStamp"
    $fastApp = $profileAppProcesses |
        Where-Object { $_.CommandLine.Contains("--app=$fastAppUrl") } |
        Select-Object -First 1
    if ($fastApp) {
        try {
            $response = Invoke-WebRequest -Uri 'http://localhost:3011/' -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) {
                for ($attempt = 0; $attempt -lt 20; $attempt++) {
                    if (Show-SuperSplatWindow $fastApp) { exit 0 }
                    Start-Sleep -Milliseconds 100
                }
            }
        } catch {
            # Continue through normal environment preparation and server start.
        }
    }
}

& (Join-Path $PSScriptRoot 'ensure-node-windows.ps1')
$nodePath = $env:SUPERSPLAT_NODE_EXE
if (-not $nodePath) { throw 'Node.js was not found after environment preparation.' }
$chromePath = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chromePath) { throw 'Google Chrome is required for the dedicated RTX launcher.' }

# A clean checkout has no dependencies or release build. Prepare those in the
# visible launcher window once so the first run is not constrained by the
# background-server timeout. Later launches skip this block entirely.
$lockFile = Join-Path $repoRoot 'package-lock.json'
$dependencyStamp = Join-Path $repoRoot 'node_modules\.package-lock.json'
$dependenciesStale = -not (Test-Path -LiteralPath $dependencyStamp) -or
    (Get-Item -LiteralPath $dependencyStamp).LastWriteTimeUtc -lt
    (Get-Item -LiteralPath $lockFile).LastWriteTimeUtc
$initialSetupRequired = $dependenciesStale -or -not (Test-Path -LiteralPath $buildFile)
if ($initialSetupRequired) {
    Write-Host ''
    Write-Host '[First launch] Installing locked dependencies and preparing the release build...' -ForegroundColor Cyan
    & $nodePath (Join-Path $repoRoot 'scripts\start-local.mjs') --setup-only
    if ($LASTEXITCODE -ne 0) {
        throw "Initial SuperSpalt setup failed with exit code $LASTEXITCODE."
    }
}

# Start the local build when the editor is not already running. The app still
# uses Chromium as its WebGPU host, but opens as a dedicated window without
# browser tabs, address bar, or a normal Chrome profile.
$listener = Get-NetTCPConnection -LocalPort 3011 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
    Start-Process -FilePath $nodePath `
        -ArgumentList @('scripts\start-local.mjs', '--no-open', '--port=3011', '--strict-port') `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden

    $ready = $false
    for ($attempt = 0; $attempt -lt 1200; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri 'http://localhost:3011/' -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $ready) {
        throw 'SuperSpalt did not build or start on port 3011 within 5 minutes.'
    }
}

if (-not (Test-Path -LiteralPath $buildFile)) { throw "SuperSpalt build is missing: $buildFile" }
$buildStamp = (Get-Item -LiteralPath $buildFile).LastWriteTimeUtc.Ticks
$appUrl = "http://localhost:3011/?build=$buildStamp"

$currentApp = $profileAppProcesses |
    Where-Object { $_.CommandLine.Contains("--app=$appUrl") } |
    Select-Object -First 1

# The build query changes whenever dist/index.js changes. Reuse and focus an
# already-running window only when it is serving this exact build.
if (-not $Restart -and $currentApp) {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (Show-SuperSplatWindow $currentApp) { exit 0 }
        Start-Sleep -Milliseconds 100
    }
}

# A stale build, an explicit -Restart, or an unresponsive app gets a clean RTX
# profile process. Normal Chrome windows are never touched.
if ($profileAppProcesses.Count -gt 0) {
    $profileAppProcesses | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 250
}

$arguments = @(
    "--user-data-dir=$rtxProfile",
    '--force_high_performance_gpu',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--start-maximized',
    '--window-position=0,0',
    '--window-size=1920,1080',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9226',
    "--app=$appUrl"
)

Start-Process -FilePath $chromePath -ArgumentList $arguments | Out-Null

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    # Chrome can hand the URL to an existing profile process and immediately
    # exit, so locate the actual app-window owner instead of trusting the
    # process object returned by Start-Process.
    $appProcessInfo = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object {
            $_.CommandLine -like "*--user-data-dir=$rtxProfile*" -and
            $_.CommandLine -like '*--app=*'
        } |
        Select-Object -First 1
    if (Show-SuperSplatWindow $appProcessInfo) { break }
}
