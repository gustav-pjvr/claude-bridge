import { timingSafeEqual } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import http from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

import {
  ALLOWED_EFFORTS, ALLOWED_MODELS, ALLOWED_PERMISSION_MODES,
  DEFAULT_CWD, HOST, MAX_WAIT_SECONDS, PERMISSION_MODE, PORT,
  PROGRESS_INTERVAL_MS, SAFE_WAIT_WITHOUT_PROGRESS, TOKEN,
  assertConfigured,
} from './config.mjs'
import {
  TERMINAL_STATES, createJob, getJob, listJobs, loadPersistedJobs, sweepOldJobs,
  waitForTerminal,
} from './jobs.mjs'
import { CLAUDE_BIN_PATH, cancelJob, runningCount, startJob } from './runner.mjs'

const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Correlates the arrival and completion log lines for one request. */
let nextRequestId = 0

function tokenMatches(presented) {
  const a = Buffer.from(presented)
  const b = Buffer.from(TOKEN)
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return a.length === b.length && timingSafeEqual(a, b)
}

function isAuthorized(req) {
  const header = req.headers.authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return false
  return tokenMatches(match[1].trim())
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

/** The caller's progressToken, when it sent one. Without it we cannot heartbeat. */
function progressToken(extra) {
  return extra?._meta?.progressToken
}

function clampWait(seconds, fallback, ceilingSeconds) {
  const requested = Number.isFinite(seconds) ? seconds : fallback
  return Math.max(0, Math.min(requested, ceilingSeconds)) * 1000
}

/** How long this call may block, given whether we can keep the caller's idle clock alive. */
function waitCeiling(extra) {
  return progressToken(extra) === undefined ? SAFE_WAIT_WITHOUT_PROGRESS : MAX_WAIT_SECONDS
}

/**
 * Wait for a job, heartbeating to the caller while we do.
 *
 * Claude Code aborts an HTTP server's tool call after 300s of silence, but a progress
 * notification resets that idle clock. Heartbeating therefore lets one call block for the
 * whole job, which takes the model's willingness to keep polling off the critical path.
 * Without a progressToken we cannot do this, so the caller-side ceiling drops accordingly.
 */
async function waitWithHeartbeat(jobId, waitMs, extra) {
  const token = progressToken(extra)
  let ticker = null

  if (token !== undefined && waitMs > PROGRESS_INTERVAL_MS) {
    const startedAt = Date.now()
    ticker = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      // A failed heartbeat is not worth failing the job over: the caller may simply have
      // stopped listening, and the job keeps running either way.
      Promise.resolve(
        extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: token,
            progress: seconds,
            message: `Delegated job still running on the remote machine (${seconds}s).`,
          },
        }),
      ).catch(() => {})
    }, PROGRESS_INTERVAL_MS)
    ticker.unref?.()
  }

  try {
    return await waitForTerminal(jobId, waitMs)
  } finally {
    if (ticker) clearInterval(ticker)
  }
}

function resolveCwd(requested) {
  if (!requested) return { cwd: DEFAULT_CWD }
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    return { error: `No such directory on this machine: ${requested}` }
  }
  return { cwd: requested }
}

/** Render a job for the calling Claude: the answer first, the bookkeeping after. */
function describeJob(job) {
  if (!TERMINAL_STATES.has(job.status)) {
    const elapsed = Math.round((Date.now() - Date.parse(job.created_at)) / 1000)
    return [
      `Job ${job.id} is still ${job.status} after ${elapsed}s. This is normal and nothing has gone wrong.`,
      '',
      'ACTION REQUIRED: call collect again with this job_id. Keep calling it until the status is',
      'done, error, cancelled or timeout. Each call waits up to '
        + `${MAX_WAIT_SECONDS}s, so a job that takes half an hour needs roughly `
        + `${Math.ceil(1800 / MAX_WAIT_SECONDS)} calls. Do not give up, do not start the work `
        + 'yourself, and do not report back to the user that it is unfinished: the remote machine '
        + 'is still working and the result is only retrievable through collect.',
      '',
      `    collect(job_id: "${job.id}")`,
    ].join('\n')
  }

  const lines = []
  if (job.status === 'done') {
    lines.push(job.result || '(the delegated session returned no text)')
  } else {
    lines.push(`Job ${job.id} ended as ${job.status}.`, '', job.error || '(no error detail)')
    if (job.result && job.result !== job.error) lines.push('', job.result)
  }

  const meta = [`status=${job.status}`]
  if (job.session_id) meta.push(`session_id=${job.session_id}`)
  if (typeof job.cost_usd === 'number') meta.push(`cost_usd=${job.cost_usd.toFixed(4)}`)
  if (typeof job.duration_ms === 'number') meta.push(`duration_ms=${job.duration_ms}`)
  if (typeof job.num_turns === 'number') meta.push(`turns=${job.num_turns}`)

  lines.push('', '---', meta.join('  '))
  if (job.session_id) {
    lines.push(`To continue this same thread, call delegate again with session_id "${job.session_id}".`)
  }
  return lines.join('\n')
}

function buildServer() {
  const server = new McpServer(
    { name: 'claude-bridge', version: '1.0.0' },
    {
      instructions:
        'Delegate work to a Claude Code session running on another machine, under a different account. '
        + 'Call delegate with a self-contained prompt. If it returns a job_id instead of an answer, poll collect with '
        + 'that job_id until the job reaches a terminal state. Pass the returned session_id back to delegate to '
        + 'continue the same conversation rather than starting a fresh one.',
    },
  )

  server.registerTool(
    'delegate',
    {
      title: 'Delegate a task to the remote Claude Code',
      description:
        'Send a task to the Claude Code session on the remote machine and wait for the answer. '
        + 'This normally blocks until the work is done and returns the result directly, even for tasks '
        + 'that take many minutes, so just wait for it. Only if the job outlasts the wait does it return '
        + 'a job_id, which you then pass to collect. '
        + 'The prompt must be self-contained: the remote session cannot see your conversation, your files '
        + 'or anything you have discussed, only this text. Referring to a task by a name you used elsewhere '
        + 'will not work; restate it in full.',
      inputSchema: {
        prompt: z.string().min(1).describe('The full, self-contained task for the remote Claude Code session.'),
        // Must be a UUID, and the shape is load-bearing, not cosmetic. `--resume [value]`
        // takes an OPTIONAL value, so a session_id beginning with "-" is not consumed as
        // the value: Claude Code parses it as its own flag. Anything caller-supplied that
        // reaches argv is therefore a flag-injection vector, and a UUID cannot start
        // with "-".
        session_id: z.string()
          .regex(
            /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
            'session_id must be a UUID',
          )
          .optional()
          .describe('Continue an earlier delegated conversation. Use the session_id from a previous result.'),
        cwd: z.string().optional()
          .describe('Absolute working directory on the remote machine. Defaults to its configured workspace.'),
        wait_seconds: z.number().int().min(0).optional()
          .describe(`How long to wait inline before returning a job_id. Capped at ${MAX_WAIT_SECONDS}.`),
        model: z.enum(ALLOWED_MODELS).optional()
          .describe('Model the remote worker should use. Defaults to that machine\'s configured model.'),
        effort: z.enum(ALLOWED_EFFORTS).optional()
          .describe('Reasoning effort for the remote worker. Higher costs more and takes longer.'),
        permission_mode: z.enum(ALLOWED_PERMISSION_MODES).optional()
          .describe('Permission posture for the remote worker. Use "plan" for a read-only dry run.'),
        allowed_tools: z.string().optional()
          .describe('Restrict the remote worker to these tools, e.g. "Read,Grep,Glob". Defaults to all of them.'),
      },
    },
    async ({ prompt, session_id, cwd, wait_seconds, model, effort, permission_mode, allowed_tools }, extra) => {
      const resolved = resolveCwd(cwd)
      if (resolved.error) return { isError: true, ...textResult(resolved.error) }

      const job = createJob({
        prompt,
        cwd: resolved.cwd,
        resumeSessionId: session_id || null,
        model,
        effort,
        allowedTools: allowed_tools,
        permissionMode: permission_mode,
      })
      console.log(
        `[bridge] delegate job=${job.id} cwd=${job.cwd} resume=${session_id || 'none'}`
        + ` model=${model || 'default'} effort=${effort || 'default'} chars=${prompt.length}`,
      )
      startJob(job)

      // Default to blocking for the whole job when we can heartbeat, so a single call
      // usually returns the answer and the caller never has to poll at all.
      const ceiling = waitCeiling(extra)
      const finished = await waitWithHeartbeat(job.id, clampWait(wait_seconds, ceiling, ceiling), extra)
      return textResult(describeJob(finished || job))
    },
  )

  server.registerTool(
    'collect',
    {
      title: 'Collect a delegated result',
      description:
        'Wait for a delegated job to finish and return its result. This long-polls, and returning '
        + 'without a result is normal, not a failure. You MUST keep calling it with the same job_id '
        + 'until the status is done, error, cancelled or timeout. A long job can need many calls in '
        + 'a row; that is expected. The result exists only here, so abandoning the loop loses the work.',
      inputSchema: {
        job_id: z.string().min(1).describe('The job_id returned by delegate.'),
        wait_seconds: z.number().int().min(0).optional()
          .describe(`How long to wait for completion before returning the current status. Capped at ${MAX_WAIT_SECONDS}.`),
      },
    },
    async ({ job_id, wait_seconds }, extra) => {
      if (!getJob(job_id)) {
        return { isError: true, ...textResult(`No job with id "${job_id}" on the remote machine.`) }
      }
      const ceiling = waitCeiling(extra)
      const job = await waitWithHeartbeat(job_id, clampWait(wait_seconds, ceiling, ceiling), extra)
      return textResult(describeJob(job))
    },
  )

  server.registerTool(
    'list_jobs',
    {
      title: 'List delegated jobs',
      description: 'Show recent delegated jobs on the remote machine, newest first.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('How many jobs to list. Default 20.'),
      },
    },
    async ({ limit }) => {
      const rows = listJobs(limit ?? 20)
      if (!rows.length) return textResult('No delegated jobs yet.')
      const table = rows.map((job) => {
        const preview = job.prompt.replace(/\s+/g, ' ').slice(0, 70)
        return `${job.id}  ${job.status.padEnd(9)}  ${job.created_at}  ${preview}`
      })
      return textResult([`${rows.length} job(s), ${runningCount()} running now:`, '', ...table].join('\n'))
    },
  )

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel a delegated job',
      description: 'Stop a delegated job that is still running on the remote machine.',
      inputSchema: { job_id: z.string().min(1).describe('The job_id to cancel.') },
    },
    async ({ job_id }) => {
      const job = getJob(job_id)
      if (!job) return { isError: true, ...textResult(`No job with id "${job_id}".`) }
      if (TERMINAL_STATES.has(job.status)) return textResult(`Job ${job_id} already finished as ${job.status}.`)
      const stopped = cancelJob(job_id)
      return textResult(stopped ? `Cancelling job ${job_id}.` : `Job ${job_id} was not running.`)
    },
  )

  return server
}

async function handleMcp(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: `Parse error: ${err.message}` },
    }))
    return
  }

  // Stateless: a fresh server and transport per request, so concurrent callers can
  // never collide on JSON-RPC request ids.
  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  res.on('close', () => {
    transport.close().catch(() => {})
    server.close().catch(() => {})
  })

  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  // Request logging. Kept in permanently: when a remote client fails to connect, the first
  // question is always whether its request reached this machine at all, and nothing else
  // answers that.
  const started = Date.now()
  const from = req.socket.remoteAddress
  const proto = req.headers['mcp-protocol-version'] || req.headers['x-mcp-protocol-version'] || '-'
  const rid = (nextRequestId += 1)

  // Log on ARRIVAL as well as completion. Logging only on completion made a long in-flight
  // long-poll indistinguishable from a client that had gone silent, which cost a wrong
  // diagnosis: a caller patiently waiting looked identical to one that had given up.
  console.log(`[http] #${rid} ${from} ${req.method} ${url.pathname} <- received proto=${proto}`)

  res.on('finish', () => {
    console.log(
      `[http] #${rid} ${from} ${req.method} ${url.pathname} -> ${res.statusCode}`
      + ` (${Date.now() - started}ms) accept=${req.headers.accept || '-'} proto=${proto}`,
    )
  })
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`[http] #${rid} ${from} ${req.method} ${url.pathname} -> CLIENT CLOSED after ${Date.now() - started}ms`)
    }
  })

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'claude-bridge', running: runningCount() }))
    return
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found. The MCP endpoint is POST /mcp\n')
    return
  }

  if (!isAuthorized(req)) {
    console.warn(`[bridge] rejected unauthenticated ${req.method} from ${req.socket.remoteAddress}`)
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <BRIDGE_TOKEN>' },
    }))
    return
  }

  if (req.method !== 'POST') {
    // Stateless mode has no server-initiated stream to attach to.
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32000, message: 'This bridge is stateless: use POST.' },
    }))
    return
  }

  handleMcp(req, res).catch((err) => {
    console.error(`[bridge] request failed: ${err.stack || err.message}`)
    if (res.headersSent) { res.end(); return }
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32603, message: `Internal error: ${err.message}` },
    }))
  })
})

function main() {
  assertConfigured()
  const restored = loadPersistedJobs()
  sweepOldJobs()
  setInterval(sweepOldJobs, 3_600_000).unref()

  httpServer.listen(PORT, HOST, () => {
    console.log(`[bridge] claude-bridge listening on http://${HOST}:${PORT}/mcp`)
    console.log(`[bridge] claude binary   ${CLAUDE_BIN_PATH}`)
    console.log(`[bridge] default cwd     ${DEFAULT_CWD}`)
    console.log(`[bridge] permission mode ${PERMISSION_MODE}`)
    console.log(`[bridge] max wait       ${MAX_WAIT_SECONDS}s with progress, ${SAFE_WAIT_WITHOUT_PROGRESS}s without`)
    console.log(`[bridge] heartbeat      every ${PROGRESS_INTERVAL_MS / 1000}s`)
    console.log(`[bridge] restored ${restored} job(s) from disk`)
  })
}

main()
