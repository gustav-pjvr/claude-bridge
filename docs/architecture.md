# Architecture

How claude-bridge works, and why it is shaped this way.

## The problem it solves

Gustav has two Anthropic accounts on two machines. He wants the Claude Code on device A to
hand work to the Claude Code on device B and get the answer back.

Claude Code has no built-in path for this. Its `SendMessage` and `ListAgents` tools, and
Remote Control, all enumerate *your own account's* sessions only. See
[research-cross-account.md](research-cross-account.md) for the evidence and the options that
were rejected.

## Shape

```
Device A (account A)                     Device B (account B, this machine)
Claude Code
  |
  |  tools/call delegate            +-- claude-bridge (node, port 8790)
  +----- HTTP over tailnet -------->|     auth, job store, long-poll
                                    |          |
  <---- result on the same call ----+          +-- spawn: claude -p --resume <id>
                                                      real files, real tools,
                                                      account B's subscription
```

The calling Claude sees four tools. Everything else is an implementation detail on device B.

| Tool | Behaviour |
|---|---|
| `delegate` | Spawns a run. Waits up to `wait_seconds` (default: the whole wait ceiling, see below). Returns the finished answer, or a `job_id`. |
| `collect` | Long-polls a `job_id` until terminal. |
| `list_jobs` | Recent jobs, newest first, with status and cost. |
| `cancel_job` | Kills a running job's process tree. |

## Why the job model exists

The binding limit on one MCP tool call is the caller's **idle** clock: Claude Code aborts an
HTTP server's call after 300 s of silence. Its wall clock defaults to about 27.8 hours and is
never the constraint. See [research-timeouts.md](research-timeouts.md).

A progress notification resets the idle clock, so while waiting the bridge heartbeats every
30 s and a call can block for up to `BRIDGE_MAX_WAIT_SECONDS` (1800). One `delegate` call
therefore usually returns the whole answer. A caller that sends no `progressToken` cannot be
heartbeated, so its ceiling drops to `BRIDGE_SAFE_WAIT_SECONDS` (240).

`delegate` still never bets on finishing inside one call. If the wait runs out it hands back
a `job_id`, the run on device B continues regardless of what the caller does, and `collect`
picks up the answer afterwards.

## Identifying the receiver

Each receiver names itself in its server instructions and tool descriptions using
`BRIDGE_LABEL`, falling back to the hostname. A sender with several receivers registered
sees their tools side by side, and without the label they would read identically. The label
only ever reaches description text, never argv.

## Modules

| File | Responsibility |
|---|---|
| `src/config.mjs` | Env config, Claude binary resolution, startup validation |
| `src/jobs.mjs` | Job records, disk persistence, long-poll wakeups, retention sweep |
| `src/runner.mjs` | Spawning `claude -p`, argv construction, process lifecycle |
| `src/server.mjs` | HTTP listener, bearer auth, MCP server and the four tools |
| `test/sleeper.mjs` | Throwaway MCP server used to measure timeout behaviour |

### config.mjs

Reads everything from env, defaults sensibly, and fails loudly at startup rather than at
first request. It refuses `BRIDGE_PERMISSION_MODE=bypassPermissions` outright: the caller is
remote and unsupervised, so that setting would hand them unattended shell.

`resolveClaudeBin()` walks a candidate list to find the real `claude.exe` so the spawn never
goes through a shell.

### jobs.mjs

Jobs live in a `Map` and are mirrored to `jobs/<uuid>.json`. Persistence means a bridge
restart does not lose finished results. A job still marked `running` at load time is
rewritten as `error`, because its child process did not survive the restart that lost it.

Long-polling is an `EventEmitter` keyed `done:<id>`, not polling. `waitForTerminal` resolves
either on the completion event or on a timer, whichever comes first. `setMaxListeners(0)`
because every concurrent waiter adds a listener.

### runner.mjs

Builds argv and spawns. Three deliberate choices:

- **The prompt goes on stdin, never argv.** It sidesteps Windows command-line length limits
  and removes any question about quoting caller-supplied text.
- **`session_id` is validated as a UUID before it reaches argv.** `--resume [value]` takes an
  *optional* value, so a value starting with `-` is parsed as its own flag. This was a
  critical vulnerability, see [security.md](security.md).
- **`killTree` uses `taskkill /T /F` on Windows.** `child.kill()` leaves Claude Code's
  descendants running.

Output is capped and the process tree is killed on bridge exit.

### server.mjs

Plain `node:http`, three routes: `GET /health` (unauthenticated liveness), `POST /mcp`
(everything), and 404 for the rest. Auth is a constant-time bearer comparison that checks
length first, since `timingSafeEqual` throws on a length mismatch.

The MCP server is **stateless**: a fresh `McpServer` and `StreamableHTTPServerTransport` per
request, with `sessionIdGenerator: undefined`. Concurrent callers therefore cannot collide on
JSON-RPC request ids, and no session header is required. This was verified: `initialize` and
`tools/list` both work with no session header.

## Session continuity

Every finished result carries a `session_id`. Passing it back to `delegate` resumes that
thread via `--resume` instead of starting cold. This is the single biggest cost lever
measured:

| Call | Duration | Cost |
|---|---|---|
| Cold, with tool use | 20.7 s | $1.59 |
| Warm resume, same thread | 5.2 s | $0.10 |

The tool descriptions tell the calling Claude to do this, so it generally happens without
prompting.

## What is deliberately absent

- **No spend cap.** Gustav asked for the worker to run unrestricted and watches it directly.
  Per-job cost is reported by `list_jobs` and in every result footer.
- **No tool allowlist by default.** `BRIDGE_ALLOWED_TOOLS` exists and is empty, so the worker
  keeps every tool it normally has.
- **No sandbox.** The delegated Claude is not confined to `cwd`. See [security.md](security.md).
