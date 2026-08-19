param(
    [Parameter(Mandatory = $true)]
    [int]$AppProcessId,

    [Parameter(Mandatory = $true)]
    [int]$ServerProcessId,

    [Parameter(Mandatory = $true)]
    [string]$ProfilePath,

    [Parameter(Mandatory = $true)]
    [string]$StateFilePath
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-ProfileWindowProcesses {
    $result = @()
    Get-Process -Name 'chrome' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        ForEach-Object {
            $windowProcess = $_
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($windowProcess.Id)"
            if ($processInfo.CommandLine -like "*--user-data-dir=$ProfilePath*") {
                $result += $windowProcess
            }
        }
    return $result
}

# Chrome can transfer top-level window ownership between processes after launch,
# so monitor every visible window in the dedicated profile rather than one PID.
$windowSeen = $false
$missingWindowChecks = 0
$startupDeadline = (Get-Date).AddSeconds(15)
while ($true) {
    $profileWindows = @(Get-ProfileWindowProcesses)
    if ($profileWindows.Count -gt 0) {
        $windowSeen = $true
        $missingWindowChecks = 0
    } elseif ($windowSeen) {
        $missingWindowChecks++
        if ($missingWindowChecks -ge 4) { break }
    } elseif ((Get-Date) -ge $startupDeadline) {
        # Never clean up a server when no window was observed after startup.
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

# Close only processes belonging to the dedicated SuperSplat profile. This
# removes Chrome background/crash helper processes without touching normal
# browser profiles.
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like "*--user-data-dir=$ProfilePath*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# PID reuse is guarded by checking the exact launcher command before stopping
# the local server. Never terminate an unrelated Node process on the same PID.
$serverInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ServerProcessId"
if ($serverInfo -and
    $serverInfo.Name -ieq 'node.exe' -and
    $serverInfo.CommandLine -like '*scripts\start-local.mjs*' -and
    $serverInfo.CommandLine -like '*--port=3011*' -and
    $serverInfo.CommandLine -like '*--strict-port*') {
    Stop-Process -Id $ServerProcessId -Force -ErrorAction SilentlyContinue
}

# Do not remove state written by a replacement app that won the restart race.
try {
    $state = Get-Content -LiteralPath $StateFilePath -Raw | ConvertFrom-Json
    if ([int]$state.appProcessId -eq $AppProcessId) {
        Remove-Item -LiteralPath $StateFilePath -Force -ErrorAction SilentlyContinue
    }
} catch {
    # Missing or malformed state does not affect process cleanup.
}
