# Launcher for the scheduled task. Runs the bridge from the project root and captures its
# output to logs/.
#
# Registered by scripts/install-autostart.ps1. Run this directly to test what the task does.
#
# IMPORTANT: node's output is redirected by the OS via Start-Process, never piped through
# PowerShell. In PowerShell 5.1, merging a native executable's stderr into the pipeline
# (`*>&1`) wraps each line as a NativeCommandError, which under $ErrorActionPreference='Stop'
# is terminating and kills the server. That bug silently killed the bridge every time a
# delegated job wrote anything to stderr, so do not reintroduce a pipeline here.

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$logDir = Join-Path $projectRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$outFile = Join-Path $logDir 'bridge.log'
$errFile = Join-Path $logDir 'bridge.err.log'

# Start-Process truncates its redirect targets, so keep one previous generation.
foreach ($f in @($outFile, $errFile)) {
    if (Test-Path $f) { Move-Item -Path $f -Destination "$f.1" -Force }
}

$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }

$proc = Start-Process -FilePath $node `
    -ArgumentList '--env-file-if-exists=.env', 'src/server.mjs' `
    -WorkingDirectory $projectRoot `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput $outFile `
    -RedirectStandardError $errFile

# Hold the task instance open for as long as the server runs, so Task Scheduler's
# "is it still running" check reflects reality.
$proc.WaitForExit()
exit $proc.ExitCode
