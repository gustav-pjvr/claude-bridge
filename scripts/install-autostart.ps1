# Registers a scheduled task that starts claude-bridge at logon.
#
#   Install:   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   Remove:    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
#
# The task runs as the logged-on user on purpose. The delegated `claude -p` needs this
# user's Claude Code credentials, which live in their profile, so running it as SYSTEM
# or another account would leave the worker unauthenticated.

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$taskName = 'claude-bridge'
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot 'scripts\start-bridge.ps1'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed scheduled task '$taskName'."
    } else {
        Write-Host "No scheduled task named '$taskName'."
    }
    return
}

if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }
if (-not (Test-Path (Join-Path $projectRoot '.env'))) {
    throw "No .env in $projectRoot. Create it from .env.example and set BRIDGE_TOKEN first."
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`"" `
    -WorkingDirectory $projectRoot

# Two triggers. The logon one starts the bridge normally. The repeating one is the
# self-heal: Task Scheduler's RestartCount only fires when a task FAILS, so a process
# that exits cleanly (a stray SIGTERM, or an operator stop) would otherwise stay dead
# until the next logon. Paired with MultipleInstances=IgnoreNew below, this five-minute
# tick is a no-op while the bridge is alive and revives it when it is not.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$healTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

$trigger = @($logonTrigger, $healTrigger)

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# ExecutionTimeLimit 0 means never kill it for running too long, which matters for a
# service. RestartCount/Interval bring it back if node crashes.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Runs the claude-bridge MCP server so another account can delegate work to this machine.' | Out-Null

Write-Host "Registered scheduled task '$taskName' (starts at logon)."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName $taskName"
Write-Host "Logs:               $projectRoot\logs\bridge.log"
