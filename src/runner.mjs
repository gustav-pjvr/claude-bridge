import { spawn } from 'node:child_process'

import {
  ALLOWED_EFFORTS,
  ALLOWED_MODELS,
  ALLOWED_PERMISSION_MODES,
  ALLOWED_TOOLS,
  ALLOWED_TOOLS_PATTERN,
  CHROME,
  EFFORT,
  JOB_TIMEOUT_MS,
  MAX_CONCURRENT_JOBS,
  MAX_OUTPUT_BYTES,
  MODEL,
  PERMISSION_MODE,
  resolveClaudeBin,
} from './config.mjs'
import { updateJob } from './jobs.mjs'

const CLAUDE_BIN = resolveClaudeBin()

/** Live child processes, so cancel_job can reach them. */
const running = new Map()

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Second line of defence against flag injection. `--resume [value]` takes an optional
 * value, so any argv token we did not construct ourselves could be parsed as a flag
 * instead. The tool schema already enforces this; enforcing it again here means no
 * future call path can reach spawn without passing it.
 */
function safeSessionId(value) {
  if (!value) return null
  if (!UUID.test(value)) throw new Error(`Refusing to spawn with a malformed session id: ${value}`)
  return value
}

/** Accept a caller value only if it is in the vocabulary, else refuse the whole run. */
function fromVocabulary(label, value, allowed) {
  if (!value) return null
  if (!allowed.includes(value)) {
    throw new Error(`Refusing to spawn: ${label} must be one of ${allowed.join(', ')}, got "${value}"`)
  }
  return value
}

function safeToolList(value) {
  if (!value) return null
  if (!ALLOWED_TOOLS_PATTERN.test(value)) {
    throw new Error(`Refusing to spawn with a malformed tool list: ${value}`)
  }
  return value
}

function buildArgs(job) {
  // The prompt goes in on stdin, never argv: it avoids Windows command-line length
  // limits and removes any question of quoting attacker-controlled text.
  //
  // Everything below that DOES reach argv is either constructed here or checked against a
  // fixed vocabulary first, so no caller value can be read as a flag.
  const model = fromVocabulary('model', job.model, ALLOWED_MODELS) ?? (MODEL || null)
  const effort = fromVocabulary('effort', job.effort, ALLOWED_EFFORTS) ?? (EFFORT || null)
  const permissionMode =
    fromVocabulary('permission_mode', job.permission_mode, ALLOWED_PERMISSION_MODES)
    ?? PERMISSION_MODE
  const tools = safeToolList(job.allowed_tools) ?? (ALLOWED_TOOLS || null)

  const args = [
    '-p',
    '--output-format', 'json',
    '--permission-mode', permissionMode,
    // Nobody is at this terminal to answer a prompt, so anything that would ask is
    // denied rather than left hanging. The permission mode still decides the rest.
    '--permission-prompts', 'none',
  ]
  // Claude in Chrome is per-session opt-in, so without this the worker quietly has no
  // browser tools even though an interactive session on this machine does.
  if (CHROME) args.push('--chrome')

  const resume = safeSessionId(job.resume_session_id)
  if (resume) args.push('--resume', resume)
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  if (tools) args.push('--allowedTools', tools)
  return args
}

function killTree(child) {
  if (process.platform === 'win32') {
    // child.kill() leaves Claude Code's own descendants running on Windows.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      .on('error', () => child.kill('SIGKILL'))
    return
  }
  child.kill('SIGKILL')
}

function parseResult(stdout) {
  const trimmed = stdout.trim()
  if (!trimmed) return { ok: false, error: 'Claude Code produced no output.' }
  try {
    const parsed = JSON.parse(trimmed)
    return { ok: true, parsed }
  } catch {
    // A non-JSON tail can appear if something wrote to stdout after the result object.
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return { ok: true, parsed: JSON.parse(trimmed.slice(start, end + 1)) }
      } catch { /* fall through to the raw-output error below */ }
    }
    return { ok: false, error: `Could not parse Claude Code output as JSON. Raw output:\n${trimmed.slice(0, 4000)}` }
  }
}

/**
 * Run one delegated Claude Code turn to completion and record the outcome on the job.
 * Never rejects: every failure path lands on the job record instead.
 */
export function startJob(job) {
  if (running.size >= MAX_CONCURRENT_JOBS) {
    updateJob(job.id, {
      status: 'error',
      error: `The bridge is already running ${running.size} delegated jobs, its limit. Retry when one finishes.`,
    })
    return
  }

  let args
  try {
    args = buildArgs(job)
  } catch (err) {
    updateJob(job.id, { status: 'error', error: err.message })
    return
  }

  let child

  try {
    child = spawn(CLAUDE_BIN, args, {
      cwd: job.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-bridge' },
    })
  } catch (err) {
    updateJob(job.id, { status: 'error', error: `Could not start Claude Code: ${err.message}` })
    return
  }

  running.set(job.id, child)

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let overflowed = false

  // Stop appending once the run exceeds the output budget, and stop the run with it:
  // a job producing this much output is not going to return a usable result object.
  const capture = (append) => (chunk) => {
    if (overflowed) return
    if (stdout.length + stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
      overflowed = true
      killTree(child)
      return
    }
    append(chunk)
  }

  child.stdout.on('data', capture((chunk) => { stdout += chunk }))
  child.stderr.on('data', capture((chunk) => { stderr += chunk }))

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, JOB_TIMEOUT_MS)

  child.on('error', (err) => {
    clearTimeout(timer)
    running.delete(job.id)
    updateJob(job.id, { status: 'error', error: `Claude Code failed to run: ${err.message}` })
  })

  child.on('close', (code) => {
    clearTimeout(timer)
    running.delete(job.id)

    if (timedOut) {
      updateJob(job.id, {
        status: 'timeout',
        error: `The delegated run exceeded ${JOB_TIMEOUT_MS} ms and was stopped.`,
      })
      return
    }
    if (overflowed) {
      updateJob(job.id, {
        status: 'error',
        error: `The delegated run produced more than ${MAX_OUTPUT_BYTES} bytes of output and was stopped.`,
      })
      return
    }
    if (getCancelled(job.id)) {
      updateJob(job.id, { status: 'cancelled', error: 'Cancelled by the caller.' })
      return
    }

    const { ok, parsed, error } = parseResult(stdout)
    if (!ok) {
      updateJob(job.id, {
        status: 'error',
        error: `${error}${stderr.trim() ? `\n\nstderr:\n${stderr.trim().slice(0, 4000)}` : ''}`,
      })
      return
    }

    const text = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed, null, 2)
    const failed = parsed.is_error === true || (code !== 0 && !text)

    updateJob(job.id, {
      status: failed ? 'error' : 'done',
      result: text,
      error: failed ? (text || `Claude Code exited with code ${code}.`) : null,
      // Carry the session id forward so the next delegate call can --resume this thread.
      session_id: parsed.session_id || job.resume_session_id || null,
      cost_usd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      duration_ms: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null,
      num_turns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
    })
  })

  child.stdin.on('error', () => { /* the close handler reports the real failure */ })
  child.stdin.end(job.prompt)
}

const cancelled = new Set()

function getCancelled(id) {
  if (!cancelled.has(id)) return false
  cancelled.delete(id)
  return true
}

/** Stop a running job. Returns false when it was already finished or unknown. */
export function cancelJob(id) {
  const child = running.get(id)
  if (!child) return false
  cancelled.add(id)
  killTree(child)
  return true
}

export function runningCount() {
  return running.size
}

/** Do not leave delegated Claude Code trees running when the bridge itself goes away. */
function killAllChildren() {
  for (const child of running.values()) killTree(child)
  running.clear()
}

for (const signal of ['exit', 'SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    killAllChildren()
    if (signal !== 'exit') process.exit(0)
  })
}

export const CLAUDE_BIN_PATH = CLAUDE_BIN
