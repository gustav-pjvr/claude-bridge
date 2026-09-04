# Decision log

Newest first. Each entry records what was decided, why, and what would reopen it.

---

## 2026-09-04: keep the job model even though long calls are allowed

**Decision.** Keep `delegate` plus `collect`, rather than switching to one long blocking call
now that the 10 minute ceiling turns out not to exist.

**Why.** Measured: a single MCP tool call slept 650 seconds and returned cleanly, and the
real wall-clock default is about 27.8 hours with no documented maximum. So blocking *is*
allowed. It is still the wrong bet. Work on device B survives a dropped connection, a
restarted caller, or a caller that gave up, and under MCP revision 2026-07-28 a closed
response stream is defined as cancellation of the request. The MCP spec endorses this exact
shape under "Stateful Tools".

Recommended alongside it: set a per-server `"timeout"` on device A so most calls return
inline anyway, since that key also floors the idle timer.

**Reopen if.** Claude Code implements the MCP tasks extension client side, at which point the
same state machine can be expressed natively.

---

## 2026-09-04: keep documentation for the whole project

**Decision.** Maintain `docs/` covering features, systems, research and decisions, updated as
work happens rather than reconstructed later.

**Why.** Gustav asked for it as a standing instruction. Most of this project's value is in
findings that are expensive to re-derive: which mechanisms are account-locked, where the
timeout ceilings actually sit, why `session_id` must be a UUID.

---

## 2026-09-04: no spend cap, no tool allowlist on the worker

**Decision.** The delegated Claude runs with `BRIDGE_ALLOWED_TOOLS` empty and no
`--max-budget-usd`.

**Why.** Gustav's explicit instruction: "do not limit account B by cost or anything, Ill be
watching". A worker that cannot edit files or run commands cannot act as an agent.

**Kept anyway, and told to him plainly.** The bearer token stays mandatory, because it is not
a limit on account B, it is what stops anyone else driving the machine. And
`bypassPermissions` stays refused at startup, with `--permission-prompts none` instead, since
nobody is at that terminal to supervise.

**Reopen if.** The bridge is ever exposed beyond a private tailnet, or a second person gets
the token.

---

## 2026-09-04: validate `session_id` as a UUID

**Decision.** Reject any `session_id` that is not a UUID, in both the tool schema and at the
spawn boundary.

**Why.** `--resume [value]` takes an optional value, so `session_id: "--dangerously-skip-permissions"`
was parsed as a flag rather than a value, defeating the startup refusal of
`bypassPermissions`. Critical severity. See [security.md](security.md).

**Reopen if.** Claude Code changes session id format. The regex would need widening, but the
"must not start with `-`" property is the load-bearing part and must survive any change.

---

## 2026-09-04: job model rather than one blocking call

**Decision.** `delegate` starts work and returns a `job_id` if it does not finish quickly;
`collect` long-polls for the result.

**Why.** `MCP_TOOL_TIMEOUT` defaults to 120000 ms with a documented maximum of 600000, and
progress notifications do not extend that wall clock. Holding one HTTP request open for an
hour was never going to work. See [research-timeouts.md](research-timeouts.md).

**Reopen if.** Claude Code turns out to support MCP async tasks as a client, in which case
the same model can be expressed natively instead of hand rolled.

---

## 2026-09-04: MCP bridge over `claude -p`, not channels or socket injection

**Decision.** Build an HTTP MCP server on device B whose tools spawn `claude -p`.

**Why.** Two-way, no preview flags, works today, and account B's credentials never leave
device B. Channels are a research preview that would need
`--dangerously-load-development-channels` for a custom channel. Inbox socket injection is
documented and stable but one-way, so device A could never receive an answer. See
[research-cross-account.md](research-cross-account.md).

**Reopen if.** Channels leave research preview. They are the more native fit.

---

## 2026-09-04: stateless MCP server

**Decision.** A fresh `McpServer` and transport per request, `sessionIdGenerator: undefined`.

**Why.** Concurrent callers cannot collide on JSON-RPC ids, and no session header is
required. Verified: `initialize` and `tools/list` both work with no session header, which was
the specific risk, since a misconfigured stateless server returns "session header is required
for non-initialize requests".
