$ErrorActionPreference = 'Stop'

if ($args.Count -lt 1) {
    Write-Error 'Usage: run-node-windows.ps1 <project-script> [arguments]'
    exit 64
}

$entryScript = $args[0]
[string[]]$entryArgs = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
$repoRoot = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot 'ensure-node-windows.ps1')
if (-not $env:SUPERSPLAT_NODE_EXE -or -not (Test-Path -LiteralPath $env:SUPERSPLAT_NODE_EXE)) {
    Write-Error 'Node.js was not found after environment preparation.'
    exit 5
}

& $env:SUPERSPLAT_NODE_EXE (Join-Path $repoRoot $entryScript) @entryArgs
exit $LASTEXITCODE
