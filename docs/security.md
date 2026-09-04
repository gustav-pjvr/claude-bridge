# Security

## Threat model

claude-bridge is, by design, an **authenticated remote code execution endpoint** on a
personal Windows machine. A `delegate` call runs Claude Code here with real filesystem and
shell access, under account B's subscription. Anyone holding the bearer token can do that.

Intended exposure is a Tailscale tailnet or a trusted LAN. It must not be port forwarded to
the public internet.

Two design decisions are accepted risk, taken deliberately by Gustav:

- **No spend cap.** The worker runs unrestricted and is watched directly.
- **No tool allowlist.** The worker keeps every tool it normally has, because a worker that
  cannot edit or run anything cannot do the job.

Neither is a defect. Everything below is about things that were *not* intended.

## Review, 2026-09-04

Adversarial review by a Fable security-reviewer pass over all source files.

### CRITICAL, fixed: argument injection via `session_id`

`delegate` accepted `session_id` as a free string and pushed it onto argv as
`--resume <value>`.

`claude --help` shows `-r, --resume [value]`, an **optional** argument. Commander therefore
does not consume a following token that begins with `-`. It parses it as its own flag. Since
the caller controls that one argv token, and Commander accepts `--flag=value` as a single
token, a caller could inject one arbitrary CLI flag into the worker:

```json
{ "name": "delegate", "arguments": {
    "prompt": "anything",
    "session_id": "--dangerously-skip-permissions" } }
```

That defeats the server's central safety decision, the startup refusal of
`bypassPermissions`. Equivalent payloads: `--permission-mode=bypassPermissions` (last wins
over the earlier `auto`), `--add-dir=C:\`, `--append-system-prompt=...`.

**Fixed** by validating `session_id` as a UUID in two places: the zod tool schema in
`server.mjs`, and again in `safeSessionId()` in `runner.mjs` at the spawn boundary, so no
future call path can reach argv unvalidated. A UUID cannot begin with `-`.

Verified: the payload above now returns `session_id must be a UUID` with no process spawned,
and normal delegation still works.

### MEDIUM, fixed: unbounded concurrent spawning

Every `delegate` spawned a child unconditionally. A caller in a loop could spawn hundreds of
`claude.exe` trees and take the machine down. This is an availability failure, distinct from
the capability limits that were declined on purpose.

**Fixed** with `MAX_CONCURRENT_JOBS`, default 6. Over the cap, the job is rejected with a
message telling the caller to retry.

### MEDIUM, fixed: unbounded output accumulation

`stdout` and `stderr` were accumulated into strings with no cap, against a one hour job
timeout. Only the JSON result object is ever used, so retaining the rest was pure memory
risk.

**Fixed** with `MAX_OUTPUT_BYTES`, default 32 MB. On overflow the child is killed and the job
is marked `error`.

### MEDIUM, documented: plaintext transcripts on disk

Prompts and results are persisted to `jobs/<uuid>.json` in clear text for seven days. Results
can contain file contents the delegated Claude read. `.gitignore` excludes `jobs/` and
`.env`. Shorten `BRIDGE_JOB_RETENTION_MS` if the exposure matters, or delete `jobs/` between
sessions.

### LOW, fixed: orphaned children

`killTree` ran only on timeout and cancel, so killing the bridge left live Claude trees
running. **Fixed** with `exit` / `SIGINT` / `SIGTERM` / `SIGBREAK` handlers that kill
everything in the running map.

### LOW, accepted: `cwd` accepts any existing directory

A caller can point `cwd` anywhere on the machine. Accepted because the delegated Claude is
not sandboxed to `cwd` in the first place, so `cwd` is not a security boundary and traversal
breaks nothing that was not already open. Noted only so nobody later mistakes it for one.

### LOW, accepted: `/health` is unauthenticated

Served before the auth check. It exposes the service name and a running-job count, nothing
else. Acceptable for a liveness probe. Drop `running` from the payload if zero pre-auth
surface is wanted.

## Reviewed and found sound

- **Auth.** `tokenMatches` checks length before `timingSafeEqual`, avoiding the
  throw-on-mismatch, and compares in constant time. Every method on `/mcp` passes through
  `isAuthorized` before anything else. No route reaches `handleMcp` unauthenticated.
- **Prompt on stdin** carries no injection risk.
- **`cwd` reaches spawn as an option, not argv**, so it cannot inject flags.
- **`model` is not caller-controlled**, it comes only from env.
- **Listener lifecycle** in `jobs.mjs` is clean: `events.once` auto-removes on fire, the
  timeout path calls `events.off`.
- **JSON parse and request error paths** are wrapped, and oversized bodies reject into a 400.

## Operational rules

- Keep `.env` out of git. `.gitignore` covers it.
- Rotate the token by changing `BRIDGE_TOKEN`, restarting, and re-running `claude mcp add` on
  device A.
- Never set `BRIDGE_PERMISSION_MODE=bypassPermissions`. The server refuses it at startup.
  Runs use `--permission-prompts none`, which denies anything that would prompt rather than
  approving it, because nobody is at that terminal to answer.
- Do not expose the port publicly. The bearer token is the only thing between a caller and a
  shell.
