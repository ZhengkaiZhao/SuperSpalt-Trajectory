$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$buildFile = Join-Path $repoRoot 'dist\index.js'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$chromePath = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chromePath) { throw 'Google Chrome is required for the dedicated RTX launcher.' }

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
    for ($attempt = 0; $attempt -lt 240; $attempt++) {
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
        throw 'SuperSpalt did not build or start on port 3011 within 60 seconds.'
    }
}

if (-not (Test-Path -LiteralPath $buildFile)) { throw "SuperSpalt build is missing: $buildFile" }
$buildStamp = (Get-Item -LiteralPath $buildFile).LastWriteTimeUtc.Ticks
$appUrl = "http://localhost:3011/?build=$buildStamp"

# A separate profile is intentional: an already-running normal Chrome process
# otherwise absorbs the command and silently ignores the GPU-selection flags.
$rtxProfile = Join-Path $env:LOCALAPPDATA 'SuperSplat-Diagnose-Chrome'

# Recreate this dedicated app process on every launch. Reusing it causes Chrome
# to keep the previous renderer, GPU backend and service-worker-controlled page
# even after dist has been rebuilt. This only closes the SuperSplat RTX profile;
# normal Chrome windows are not affected.
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object {
        $_.CommandLine -like "*--user-data-dir=$rtxProfile*" -and
        $_.CommandLine -like '*--app=*'
    } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Milliseconds 500

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

# Chrome persists the previous app-window placement. If the last session was
# minimized, it can reopen at Windows' hidden (-25600, -25600) coordinates and
# make the renderer look blank. Restore and maximize the real top-level window
# after Chrome has created it.
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
    $appProcess = if ($appProcessInfo) {
        Get-Process -Id $appProcessInfo.ProcessId -ErrorAction SilentlyContinue
    }
    if ($appProcess -and $appProcess.MainWindowHandle -ne 0) {
        [SuperSplatWindow]::ShowWindow($appProcess.MainWindowHandle, 9) | Out-Null
        [SuperSplatWindow]::ShowWindow($appProcess.MainWindowHandle, 3) | Out-Null
        [SuperSplatWindow]::SetForegroundWindow($appProcess.MainWindowHandle) | Out-Null
        break
    }
}
