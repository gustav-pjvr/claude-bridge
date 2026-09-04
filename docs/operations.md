# Operations and troubleshooting

Everything needed to run the bridge day to day, plus the failures actually hit in
production and how each was identified.

## Is it alive?

```powershell
curl.exe http://127.0.0.1:8790/health          # from this machine
Get-ScheduledTask -TaskName claude-bridge      # State should be Running
Get-ScheduledTaskInfo -TaskName claude-bridge  # LastTaskResult 0x0 is healthy
```

From the sender, the same check across the tailnet:

```
curl http://100.70.125.65:8790/health
```

`{"ok":true,"service":"claude-bridge","running":N}` means the server is up. This endpoint is
unauthenticated on purpose, so it isolates "is it reachable" from "is my token right".

## The logs

| File | Contents |
|---|---|
| `logs/bridge.log` | Startup banner, every HTTP request, every delegation |
| `logs/bridge.err.log` | Anything node writes to stderr |
| `logs/*.log.1` | Previous generation, rotated on each start |

Request lines are the primary diagnostic:

```
[http] 100.84.243.120 POST /mcp -> 401 (7ms) accept=application/json,text/event-stream proto=2026-07-28
```

They answer, in one line, the question that otherwise takes an hour of guessing: **did the
client's request reach this machine at all, and what did we say back?**

- **No line at all**: the request never arrived. Network, firewall, or the server is down.
- **A line with 401**: arrived fine, token is wrong.
- **A line with 200**: the bridge did its job; any remaining problem is client side.
- **`CLIENT CLOSED after Nms`**: the caller gave up before we answered.

## Failure modes seen in production

### The server dies silently and keeps coming back

**Symptom.** Remote clients report `Version negotiation probe timed out after 5000ms`, while
a `/health` check from the same machine sometimes succeeds. `logs/bridge.log` shows repeated
startup banners minutes apart with nothing in between.

**Cause.** `start-bridge.ps1` originally piped node's output through PowerShell with `*>&1`
under `$ErrorActionPreference = 'Stop'`. In PowerShell 5.1, merging a native executable's
stderr into the pipeline wraps each line as a `NativeCommandError`, which is *terminating*.
The first thing node wrote to stderr killed the server. The five-minute self-heal trigger
then resurrected it, which masked the crash and made the whole thing look intermittent.

**Fix.** The launcher uses `Start-Process` with OS-level redirection and no PowerShell
pipeline. Do not reintroduce a pipeline around node.

**Tell-tale.** `Get-ScheduledTaskInfo` shows `LastTaskResult 0x1`, no `node.exe` running, and
an orphaned `powershell.exe`.

### 401 after a token rotation

**Symptom.** `Server rejected the configured Authorization header (HTTP 401)`, and
`bridge.log` shows the sender's requests arriving and being refused in a few milliseconds.

**Cause.** The token changed here but the sender still presents the old one.

**Fix.** Re-register on the sender. See below, and note the `remove` is not optional.

## Rotating the token

On this machine:

```powershell
cd "C:\Users\HP 865 G10\Desktop\Claude WorkSpace\claude-bridge"
node -e "const fs=require('fs'),c=require('crypto');const t=c.randomBytes(32).toString('hex');let s=fs.readFileSync('.env','utf8');s=s.replace(/^BRIDGE_TOKEN=.*$/m,'BRIDGE_TOKEN='+t);fs.writeFileSync('.env',s)"
Stop-ScheduledTask -TaskName claude-bridge; Start-Sleep 3; Start-ScheduledTask -TaskName claude-bridge
```

Then on the sender, with the new value:

```powershell
claude mcp remove claude-bridge --scope user
claude mcp add --transport http claude-bridge http://100.70.125.65:8790/mcp --scope user --header "Authorization: Bearer <new token>"
```

**`claude mcp add` refuses to overwrite an existing entry**, so the `remove` is required. It
fails with "MCP server claude-bridge already exists in user config" otherwise, and the old
token silently stays in force.

Rotation is only complete once both sides are done. Verify with a `200` in `bridge.log`.

## Updating the bridge

The sender holds **only a URL and a token**. Tools are discovered from this machine at
connection time, so changes to the tool surface need no action on the sender beyond
restarting Claude Code. A re-registration is needed only when the URL, token or transport
changes.

On this machine, after pulling changes:

```powershell
Stop-ScheduledTask -TaskName claude-bridge; Start-Sleep 3; Start-ScheduledTask -TaskName claude-bridge
```

## Restart behaviour

The scheduled task carries two triggers: at logon, and a five-minute repetition paired with
`MultipleInstances=IgnoreNew`. The repetition is the self-heal, and it exists because Task
Scheduler's `RestartCount` fires only when a task *fails*, so a clean exit would otherwise
leave the bridge dead until the next logon.

Worst-case recovery is therefore about five minutes. Measured: killing the process outright,
it came back unaided in 243 seconds.

**The self-heal masks crashes.** If the bridge seems flaky rather than dead, always check
`bridge.log` for repeated startup banners before assuming a client-side problem.

## Re-registering the scheduled task

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

This unregisters and re-registers, which **stops the running instance without starting a new
one**, and can leave the old node process orphaned and still holding port 8790. After
running it, kill any orphan and start the task so it owns the process:

```powershell
(Get-NetTCPConnection -LocalPort 8790 -State Listen).OwningProcess | Stop-Process -Force
Start-ScheduledTask -TaskName claude-bridge
```

Remove the task entirely with `-Uninstall`.
