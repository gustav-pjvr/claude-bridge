# claude-bridge

Lets a Claude Code session on **another machine, under another Anthropic account**, delegate
work to the Claude Code on **this** machine and get the answer back on the same call.

Claude Code's own `SendMessage` and Remote Control only ever reach *your own* account's
sessions, so there is no built-in way to do this. This bridge is the gap-filler: it exposes
this machine's Claude Code as an MCP server that the other account registers as a tool.

```
Device A (account A)                       Device B (account B, this machine)
Claude Code
  |  tools/call delegate
  +------ HTTPS/tailnet ------>  claude-bridge  --spawn-->  claude -p
  <----- result on same call --                             (real files, real tools)
```

## What the calling Claude gets

| Tool | Purpose |
|---|---|
| `delegate` | Send a task. Returns the answer if it finishes in time, otherwise a `job_id`. |
| `collect` | Long-poll a `job_id` until the job reaches a terminal state. |
| `list_jobs` | Recent jobs on this machine, newest first. |
| `cancel_job` | Stop a job that is still running. |

Every finished result carries a `session_id`. Pass it back to `delegate` to continue the same
thread instead of starting cold. That is also much cheaper: in testing, the first call cost
$1.59 and the cached follow-up on the same session cost $0.10.

## Setup on this machine (device B)

```bash
cd "C:\Users\HP 865 G10\Desktop\Claude WorkSpace\claude-bridge"
npm install
npm run token          # copy the output
cp .env.example .env   # then paste the token into BRIDGE_TOKEN
npm start
```

The server prints the endpoint, the Claude binary it resolved, the working directory and the
permission mode. Confirm it is alive with `curl http://127.0.0.1:8790/health`.

### Reaching it from device A

Tailscale is already installed here and is the right answer: a private tailnet, nothing
exposed to the internet. It is currently logged out, so bring it up first:

```bash
tailscale up
```

This node is `xbox-wireless-connecter-wifi4` at `100.70.125.65`. Device A then uses
`http://100.70.125.65:8790/mcp`.

On a plain LAN, use this machine's LAN IP and open the port in Windows Firewall. Do not port
forward this to the public internet: the bearer token is the only thing between a caller and
a shell on this machine.

## Setup on the other machine (device A)

```bash
claude mcp add --transport http claude-bridge http://100.70.125.65:8790/mcp \
  --header "Authorization: Bearer <the BRIDGE_TOKEN>"
```

Optionally give that server a generous tool timeout. There is **no** 10 minute ceiling, and
the per-server key also floors the idle timer:

```bash
claude mcp add-json claude-bridge '{"type":"http","url":"http://100.70.125.65:8790/mcp","headers":{"Authorization":"Bearer <token>"},"timeout":7200000}'
```

`delegate` still hands back a `job_id` rather than betting on one held-open request: work on
this machine continues regardless of what the caller does, and `collect` picks the answer up
afterwards. See [docs/research-timeouts.md](docs/research-timeouts.md) for the measurements.

### More than one receiver

One sender can reach several receivers. Install the bridge on each receiver as above, with its
own token and its own `BRIDGE_LABEL`, then register each one on the sender under its own name:

```bash
claude mcp add --transport http claude-bridge-hp     http://100.70.125.65:8790/mcp --scope user --header "Authorization: Bearer <hp token>"
claude mcp add --transport http claude-bridge-laptop http://<laptop ip>:8790/mcp  --scope user --header "Authorization: Bearer <laptop token>"
```

Each entry reaches exactly one machine, and the sending model picks a machine by picking the
tool (`mcp__claude-bridge-hp__delegate` or `mcp__claude-bridge-laptop__delegate`). The label
appears in each receiver's tool descriptions, so the model can see which is which.

## Configuration

All settings live in `.env`, documented in `.env.example`. The ones that matter:

- `BRIDGE_TOKEN` (required) shared secret, minimum 24 characters
- `BRIDGE_LABEL` how this receiver names itself in its tool descriptions. Defaults to the
  hostname. Set it to something a model can act on, since it is how a sender with several
  receivers chooses between them
- `BRIDGE_CWD` working directory delegated runs start in
- `BRIDGE_PERMISSION_MODE` defaults to `auto`, matching this machine's interactive default
- `BRIDGE_ALLOWED_TOOLS` empty by default, so the worker keeps every tool it normally has
- `BRIDGE_MAX_WAIT_SECONDS` longest a single tool call blocks, default 1800. The bridge
  heartbeats with progress notifications while waiting, which resets the caller's idle clock,
  so one call normally returns the answer even for a job lasting many minutes
- `BRIDGE_SAFE_WAIT_SECONDS` fallback ceiling of 240 when the caller sends no
  `progressToken` and we therefore cannot keep its idle clock alive

There is deliberately no spend cap: the owner asked for the worker to run unrestricted and
watches it directly. `list_jobs` reports per-job cost, and every delegation is logged to the
server console with its working directory and prompt length.

## Security

The design point to keep in mind: **a `delegate` call runs Claude Code on this machine with
real filesystem and shell access.** Anyone holding the token can do that.

- Keep `.env` out of git. `.gitignore` already covers it, along with `jobs/`.
- `BRIDGE_PERMISSION_MODE=bypassPermissions` is refused by the server on startup. Nobody is
  at this terminal to supervise, so runs use `--permission-prompts none`, which denies
  anything that would prompt rather than silently approving it.
- Prompts and results are persisted as plaintext JSON under `jobs/` for seven days, so
  whatever the remote account sends and whatever this machine answers is on disk. Shorten
  `BRIDGE_JOB_RETENTION_MS` if that matters.
- Rotate the token by changing `BRIDGE_TOKEN`, restarting, and re-running `claude mcp add`
  on device A.

## Controlling the worker from the sender

`delegate` takes more than a prompt. The sender chooses how the remote agent runs, per call:

| Argument | Values | Effect |
|---|---|---|
| `model` | `fable`, `opus`, `sonnet` | Which model does the work |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | Reasoning depth |
| `permission_mode` | `auto`, `acceptEdits`, `dontAsk`, `plan` | Use `plan` for a read-only dry run |
| `allowed_tools` | e.g. `"Read,Grep,Glob"` | Narrow the worker's tools |
| `cwd` | absolute path | Where it runs |
| `session_id` | from a previous result | Continue that thread instead of a new one |

Every one of these is a **fixed vocabulary**, not a free string, and that is deliberate. Each
value ends up in the worker's argv, and a free string there is a flag-injection vector. See
[docs/security.md](docs/security.md) for the critical bug that taught us this.

Two behaviours worth knowing:

- **Every call is a new chat by default.** Omit `session_id` and the worker starts fresh with
  no memory of previous calls. Pass one and it resumes, which is roughly twelve times cheaper.
- **Calls run in parallel.** Up to `BRIDGE_MAX_CONCURRENT_JOBS` (default 6) delegations run at
  once, so the sender can fan out several agents on different models simultaneously.

Haiku is deliberately not offered as a model.

## Running it as a service

`npm start` dies with the terminal. To keep the bridge up across reboots, register the
scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
Start-ScheduledTask -TaskName claude-bridge
```

It starts at logon, restarts on crash, has no execution time limit, and logs to
`logs/bridge.log`. Remove it with `-Uninstall`.

The task deliberately runs **as the logged-on user**, not SYSTEM. The delegated `claude -p`
needs this user's Claude Code credentials from their profile, so any other account would
leave the worker unauthenticated.

Check on it:

```powershell
Get-ScheduledTask -TaskName claude-bridge
Get-Content logs\bridge.log -Tail 20
```

## Documentation

| Doc | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How it works, module by module, and why |
| [docs/research-cross-account.md](docs/research-cross-account.md) | What is account-locked, and the options rejected |
| [docs/operations.md](docs/operations.md) | Running it, reading the logs, failures hit in production |
| [docs/research-timeouts.md](docs/research-timeouts.md) | The two timeout clocks, measured not inferred |
| [docs/security.md](docs/security.md) | Threat model, review findings, accepted risks |
| [docs/decisions.md](docs/decisions.md) | Dated decision log |

## Notes

- The prompt is delivered on stdin, never argv, which sidesteps Windows command-line length
  limits and any quoting question about caller-supplied text.
- The server is stateless: a fresh MCP server and transport per request, so concurrent
  callers cannot collide on JSON-RPC ids.
- Jobs are persisted, so a restart does not lose finished results. A job still marked running
  when the server restarts is recorded as failed, since its child did not survive.
