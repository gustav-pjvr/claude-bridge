# Research: MCP tool-call timeouts

Investigated 2026-09-04, Claude Code v2.1.260.

**Question.** Can a single MCP tool call run longer than the widely cited 600000 ms maximum,
so `delegate` could just block until the work is done?

**Answer. Yes. There is no 10 minute ceiling.** It was measured, not inferred: a tool call
slept 650 seconds and returned cleanly.

> A correction is recorded here on purpose. An early doc fetch returned truncated content and
> the summarising model reconstructed plausible-looking values, "default 120000, maximum
> 600000". Both are wrong, and they were relayed as verified before being checked. The real
> values are below.

## The knobs

| Variable | Real default | Meaning |
|---|---|---|
| `MCP_TIMEOUT` | 30000 ms | Server connection and request timeout |
| `MCP_TOOL_TIMEOUT` | **about 27.8 hours** | Wall clock per tool call |
| `MAX_MCP_OUTPUT_TOKENS` | 100000 | Result truncation point, with `get_mcp_tool_result_full` to fetch the rest |
| `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` | 300000 non-stdio, 1800000 stdio | Silence timeout, `0` disables |
| `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | 120000 | When a call moves to a background task, `0` disables |

From the installed binary, the wall clock resolves as:

```js
n = (perServer.timeout >= 1000 ? perServer.timeout : undefined)
    ?? MCP_TOOL_TIMEOUT
    ?? Pr                       // Pr = 1e8 ms = 27.8 hours
return Math.min(Math.max(n, 1000), ob)   // ob = 2147483647
```

`ob = 2147483647` is `2^31 - 1`, the largest delay Node's `setTimeout` accepts, roughly 24.8
days. It is a JavaScript limit, not a policy ceiling. The public docs agree, giving an unset
default of "about 28 hours" and stating **no** maximum.

## The per-server `"timeout"` key

Publicly documented, and the better knob because it does two jobs at once:

```json
{ "mcpServers": { "claude-bridge": {
    "type": "http",
    "url": "http://100.70.125.65:8790/mcp",
    "timeout": 7200000 } } }
```

- Overrides `MCP_TOOL_TIMEOUT` for that server only.
- Values below 1000 are ignored and fall through to the env var or the default.
- **Since v2.1.203 it also acts as a floor on the idle timeout**, so one setting covers both
  clocks and the 5 minute idle default stops mattering for HTTP servers.

## Two clocks, and only one is resettable

| Clock | Set by | Reset by progress notifications? |
|---|---|---|
| **Wall clock**, per call | `MCP_TOOL_TIMEOUT` or per-server `"timeout"` | **No** |
| **Idle**, silence since last message | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` | **Yes** |

Claude Code's own internal description of the per-server key states it plainly:

> Hard wall-clock limit per call; progress notifications do not extend it. Values below
> 1000ms are ignored.

The bundled MCP SDK does implement `resetTimeoutOnProgress` and `maxTotalTimeout`, but there
is no sign Claude Code enables the former for tool calls, consistent with that description.

The idle clock's error message names both remedies itself:

> MCP server "X" tool "Y" sent no response or progress for Ns; aborting. If this server is
> configured in your MCP settings, set a per-server "timeout" (ms) to allow longer silent
> runs for just this server; otherwise set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms) globally
> (0 disables).

## Automatic backgrounding

Claude Code v2.1.212 and later: an MCP tool call in the main conversation still running after
two minutes **moves to a background task instead of blocking the session**. Claude receives a
task id immediately and keeps working; the result arrives as a task notification. It appears
in `/tasks` and does not survive exiting the session.

The wall-clock and idle limits still apply in the background, so this makes a long call
tolerable rather than longer. Note it is **not** applied in `claude -p` unless
`CLAUDE_AUTO_BACKGROUND_TASKS=1`, nor to subagent calls or IDE servers.
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` turns off background tasks entirely.

## Experiment

`test/sleeper.mjs` is a throwaway stdio MCP server with one tool that sleeps for N seconds and
optionally emits progress.

```bash
MCP_TOOL_TIMEOUT=1200000 claude -p "Call the sleep tool with seconds=650..." \
  --mcp-config '{"mcpServers":{"sleeper":{"command":"node","args":["test/sleeper.mjs"],"timeout":1200000}}}' \
  --strict-mcp-config --allowedTools "mcp__sleeper__sleep" --model sonnet --output-format json
```

| Run | Sleep | Outcome |
|---|---|---|
| Sanity | 20 s | `SLEPT_OK for 20s`, harness sound |
| Cap test | 650 s | `SLEPT_OK for 650s`, `is_error: false`, 659.4 s total, 3 turns |

650 seconds is 50 seconds past the supposed ceiling, and it returned cleanly. **No 600000 ms
maximum exists.**

## MCP async tasks: exists in the spec, not supported by Claude Code

The `taskId` and "side-channelled request" strings in Claude Code's bundle looked like
support for the MCP task augmentation. They are not.

- The spec does have it: `io.modelcontextprotocol/tasks`, revision 2026-07-28, promoted out
  of core into an official extension (SEP-2663). A server returns
  `{"resultType": "task", "taskId": ..., "status": "working", ...}` and the client polls
  `tasks/get`. An earlier experimental form lived in revision 2025-11-25 with `tasks/get`,
  `tasks/result`, `tasks/list`, `tasks/cancel`.
- **Claude Code does not implement the client side.** The MCP TypeScript SDK 2.0 migration
  notes state the experimental tasks interception layer was removed entirely and inbound
  `tasks/*` returns `-32601`. Claude Code appears in no client support matrix for the
  extension. The strings in the bundle are exported wire types.

A server must never return a task to a client that did not declare support, so this is not
something the bridge can opt into unilaterally.

**This validates the bridge's design.** The MCP tools spec endorses exactly the hand-rolled
shape under "Stateful Tools": return an opaque handle from a creation tool and accept it on
subsequent calls. That is `delegate` and `collect`.

## `MCP_PROTOCOL_NEGOTIATION`

Values `auto` or `legacy`, with companion `MCP_SDK_GENERATION` (`v1` or `v2`). v2 is the SDK
2.0 runtime that adds protocol revision 2026-07-28, and is the default from v2.1.232 outside
Bedrock, Vertex, Foundry and gateway setups. Claude Code asks HTTP servers about the newer
revision automatically, and stdio servers only under `auto`.

Irrelevant to this problem: it changes the protocol era, not the timers. Leave it alone. Note
that a channel server negotiating 2026-07-28 is not registered as a channel, and that
revision removes `Last-Event-ID` SSE resumability.

## Practical conclusions

1. **Set a per-server `"timeout"` on device A.** It raises the wall clock and floors the idle
   timer in one move. There is no ceiling to work around.
2. **Keep the job model anyway.** Work on device B survives a dropped connection, a restarted
   caller, or a caller that gave up. Betting an hour of work on one held-open HTTP request is
   fragile even when it is allowed. Under 2026-07-28, a closed response stream is defined as
   cancellation of the request.
3. **Emit progress notifications from long-blocking tools.** They do not help the wall clock
   but do hold off the idle timer, which defaults to 5 minutes for HTTP servers.
4. **Keep `BRIDGE_MAX_WAIT_SECONDS` under the caller's wall clock.** The default of 90 is safe
   against any caller.
5. Revisit the tasks extension when Claude Code implements it. The migration would be small,
   since the bridge already has the state machine.
