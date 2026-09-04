# Research: cross-account Claude Code messaging

Investigated 2026-09-04, Claude Code v2.1.260 on Windows.

**Question.** Can a Claude Code session under one Anthropic account send work to a Claude Code
session under a different account on another machine, and get the answer back?

**Answer.** Not with anything built in. Every native mechanism is scoped to a single account.
A custom bridge is required, and three viable shapes exist.

## What is account-locked, and the evidence

| Mechanism | Same account, same machine | Same account, other machine | Different accounts |
|---|---|---|---|
| `SendMessage` / `ListAgents` | Yes | Yes, via Remote Control | **No** |
| Remote Control | n/a | Yes | **No** |
| Agent teams, subagents | Yes | n/a | **No** |

Local evidence gathered on this machine:

- This session's own peer address was `claude-workspace-ce [51ed29]`.
- Same-machine delivery runs over a per-user named pipe, `\\.\pipe\cc-daemon-*-control`,
  keyed by `~/.claude/daemon/control.key` and `pipe.key`. Windows restricts these to the
  owning OS user, so there is no cross-account path even locally.
- `~/.claude/settings.json` had `remoteControlAtStartup: false`.

Documentation evidence, from
<https://code.claude.com/docs/en/cross-session-messaging.md>:

- The page is titled "Message your **other** Claude Code sessions" and consistently scopes to
  "your" sessions.
- Cross-machine delivery goes "Through Anthropic servers, arriving over that machine's Remote
  Control connection", and Remote Control "needs a claude.ai sign-in as this session's active
  authentication".
- Claude Code enumerates cloud and Remote Control sessions from **your account's** session
  lists. There is no federation, and no way to name another account's session.

Two settings keys govern inbound messages, both confirmed present in the installed binary:
`crossSessionInbound` (`accept` / `hold` / `refuse`) and `isolatePeerMachines` (`true`
requires approval before any message leaves the machine, even under `bypassPermissions`).

## Option 0: use one account

If both accounts belong to the same person, putting both machines on one account makes every
built-in mechanism work with zero code. Ruled out here because Gustav wants the two accounts
kept separate.

## Option 1: channels

A **channel** is an MCP server that pushes events *into* an already-running session, and
Claude can reply back out through it. The docs name "webhook receiver" as an intended use.

```bash
claude --channels plugin:<name>@<marketplace>
```

Rejected for now, on these grounds:

- Research preview. `--channels` does not appear in `claude --help`.
- During the preview, `--channels` only accepts plugins from an Anthropic-maintained
  allowlist. A channel you write yourself needs `--dangerously-load-development-channels`.
- Official plugins require Bun.
- Not available on Bedrock, Vertex or Foundry.

Worth revisiting when it leaves preview: it is the most native fit, and it is two-way.

Refs: <https://code.claude.com/docs/en/channels.md>,
<https://code.claude.com/docs/en/channels-reference.md>

## Option 2: inbox socket injection

Officially documented as an extension point: *"Read this section when a session you expect
isn't in the agent list, when you want a script or hook to post into a session."*

Each session exports:

- `CLAUDE_CODE_MESSAGING_SOCKET`, the pipe path, also shown by `/status` as `Peer address`
- `CLAUDE_CODE_MESSAGING_TOKEN`

**On native Windows the auth line is mandatory.** The first line of the connection must be:

```json
{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
```

Anything else and the connection is closed with nothing delivered. Other constraints: open
the connection only when the message is ready, since Claude Code closes a connection that has
not sent a complete line within 30 seconds; the cap is roughly one million serialized
characters; bursts are rate limited and at most 50 accepted messages queue.

Rejected as the primary mechanism because it is **one-way**. A message posted by a script
carries no reply address, so device A cannot receive an answer. It remains the right tool if
device B ever needs to interrupt device A unprompted.

## Option 3: MCP bridge over `claude -p` (chosen)

Device B runs an HTTP MCP server whose tools spawn `claude -p` locally. Device A registers it:

```bash
claude mcp add --transport http claude-bridge http://<host>:8790/mcp \
  --header "Authorization: Bearer <token>"
```

Chosen because it is two-way, needs no preview flags, works today, and puts the account
boundary in exactly one place: the bridge holds account B's credentials and account A never
sees them.

Verified working end to end. See [architecture.md](architecture.md) for the design and
[security.md](security.md) for the review.

## Billing

Whichever account's credentials the worker process runs under pays for the work. Here that is
account B on device B. Account A pays only for its own tokens plus ingesting the result.

## Corrections worth remembering

Two claims that surfaced during research and turned out to be wrong, checked against the
installed binary:

- There is **no** `--max-turns` flag in v2.1.260.
- The budget flag is `--max-budget-usd`, not `--max-cost-usd`.
