# Launcher for the scheduled task. Runs the bridge from the project root and appends
# output to logs/bridge.log, which the task itself cannot do.
#
# Registered by scripts/install-autostart.ps1. Run this directly to test what the task does.

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$logDir = Join-Path $projectRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'bridge.log'

# Keep the log from growing without bound across reboots.
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 10MB)) {
    Move-Item -Path $logFile -Destination "$logFile.1" -Force
}

"=== bridge start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File -FilePath $logFile -Append -Encoding utf8

$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

& $node --env-file-if-exists=.env src/server.mjs *>&1 |
    ForEach-Object { "$(Get-Date -Format 'HH:mm:ss') $_" } |
    Out-File -FilePath $logFile -Append -Encoding utf8
