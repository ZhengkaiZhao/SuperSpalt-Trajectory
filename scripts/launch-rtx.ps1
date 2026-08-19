param(
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$buildFile = Join-Path $repoRoot 'dist\index.js'
$rtxProfile = Join-Path $env:LOCALAPPDATA 'SuperSplat-Diagnose-Chrome'
$launcherStateFile = Join-Path $rtxProfile 'supersplat-launcher-state.json'
$watcherScript = Join-Path $PSScriptRoot 'watch-rtx-lifecycle.ps1'

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

function Get-SuperSplatWindowProcess {
    Get-Process -Name 'chrome' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        ForEach-Object {
            $windowProcess = $_
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($windowProcess.Id)"
            if ($processInfo.CommandLine -like "*--user-data-dir=$rtxProfile*") {
                $processInfo
            }
        } |
        Select-Object -First 1
}

function Read-LauncherState {
    try {
        return Get-Content -LiteralPath $launcherStateFile -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Stop-LifecycleWatcher {
    $state = Read-LauncherState
    if (-not $state -or -not $state.watcherProcessId) { return }
    $watcherInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.watcherProcessId)" `
        -ErrorAction SilentlyContinue
    if ($watcherInfo -and $watcherInfo.Name -ieq 'powershell.exe' -and
        $watcherInfo.CommandLine.Contains($watcherScript)) {
        Stop-Process -Id $watcherInfo.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Start-LifecycleWatcher([int]$AppProcessId, [int]$ServerProcessId, [long]$BuildStamp) {
    $state = Read-LauncherState
    if ($state -and
        [int]$state.appProcessId -eq $AppProcessId -and
        [int]$state.serverProcessId -eq $ServerProcessId -and
        [long]$state.buildStamp -eq $BuildStamp -and
        $state.watcherProcessId) {
        $watcherInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.watcherProcessId)" `
            -ErrorAction SilentlyContinue
        if ($watcherInfo -and $watcherInfo.Name -ieq 'powershell.exe' -and
            $watcherInfo.CommandLine.Contains($watcherScript)) {
            return
        }
    }

    Stop-LifecycleWatcher
    $watcherArguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$watcherScript`"",
        '-AppProcessId', $AppProcessId,
        '-ServerProcessId', $ServerProcessId,
        '-ProfilePath', "`"$rtxProfile`"",
        '-StateFilePath', "`"$launcherStateFile`""
    )
    $watcher = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
        -ArgumentList $watcherArguments `
        -WindowStyle Hidden `
        -PassThru
    [pscustomobject]@{
        appProcessId = $AppProcessId
        serverProcessId = $ServerProcessId
        watcherProcessId = $watcher.Id
        buildStamp = $BuildStamp
    } | ConvertTo-Json | Set-Content -LiteralPath $launcherStateFile -Encoding UTF8
}

# Fast reopen: before checking Node.js or scanning project state, restore the
# app when its recorded process IDs and build stamp are still valid.
if (-not $Restart -and (Test-Path -LiteralPath $buildFile)) {
    $fastBuildStamp = (Get-Item -LiteralPath $buildFile).LastWriteTimeUtc.Ticks
    $fastState = Read-LauncherState
    if ($fastState -and [long]$fastState.buildStamp -eq $fastBuildStamp) {
        $fastApp = Get-SuperSplatWindowProcess
        $fastServer = Get-Process -Id ([int]$fastState.serverProcessId) -ErrorAction SilentlyContinue
        try {
            $response = Invoke-WebRequest -Uri 'http://localhost:3011/' -UseBasicParsing -TimeoutSec 1
            if ($fastApp -and $fastApp.Name -ieq 'chrome.exe' -and
                $fastServer -and $fastServer.ProcessName -ieq 'node' -and
                $response.StatusCode -eq 200) {
                for ($attempt = 0; $attempt -lt 20; $attempt++) {
                    if (Show-SuperSplatWindow $fastApp) {
                        Start-LifecycleWatcher $fastApp.ProcessId $fastServer.Id $fastBuildStamp
                        exit 0
                    }
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
$listener = Get-NetTCPConnection -LocalPort 3011 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
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

$listener = Get-NetTCPConnection -LocalPort 3011 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $listener) { throw 'SuperSpalt server did not acquire port 3011.' }
$serverProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" `
    -ErrorAction SilentlyContinue
if (-not $serverProcessInfo -or
    $serverProcessInfo.Name -ine 'node.exe' -or
    $serverProcessInfo.CommandLine -notlike '*scripts\start-local.mjs*' -or
    $serverProcessInfo.CommandLine -notlike '*--port=3011*' -or
    $serverProcessInfo.CommandLine -notlike '*--strict-port*') {
    throw 'Port 3011 is not owned by this SuperSpalt local server.'
}
$serverProcessId = [int]$listener.OwningProcess

if (-not (Test-Path -LiteralPath $buildFile)) { throw "SuperSpalt build is missing: $buildFile" }
$buildStamp = (Get-Item -LiteralPath $buildFile).LastWriteTimeUtc.Ticks
$appUrl = "http://localhost:3011/?build=$buildStamp"

$profileAppProcesses = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object {
        $_.CommandLine -like "*--user-data-dir=$rtxProfile*" -and
        $_.CommandLine -like '*--app=*'
    })
$currentState = Read-LauncherState
$currentApp = if ($currentState -and [long]$currentState.buildStamp -eq $buildStamp) {
    Get-SuperSplatWindowProcess
}

# The build query changes whenever dist/index.js changes. Reuse and focus an
# already-running window only when it is serving this exact build.
if (-not $Restart -and $currentApp) {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (Show-SuperSplatWindow $currentApp) {
            Start-LifecycleWatcher $currentApp.ProcessId $serverProcessId $buildStamp
            exit 0
        }
        Start-Sleep -Milliseconds 100
    }
}

# A stale build, an explicit -Restart, or an unresponsive app gets a clean RTX
# profile process. Normal Chrome windows are never touched.
if ($profileAppProcesses.Count -gt 0) {
    Stop-LifecycleWatcher
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

$windowReady = $false
Start-Process -FilePath $chromePath -ArgumentList $arguments | Out-Null

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    # Chrome can hand the URL to an existing profile process and immediately
    # exit, so locate the actual app-window owner instead of trusting the
    # process object returned by Start-Process.
    $appProcessInfo = Get-SuperSplatWindowProcess
    if (Show-SuperSplatWindow $appProcessInfo) {
        Start-LifecycleWatcher $appProcessInfo.ProcessId $serverProcessId $buildStamp
        $windowReady = $true
        break
    }
}

if (-not $windowReady) {
    throw 'Chrome started but the SuperSpalt RTX app window was not created within 10 seconds.'
}
