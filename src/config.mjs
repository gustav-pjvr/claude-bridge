import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Where job state and transcripts are written. */
export const JOBS_DIR = process.env.BRIDGE_JOBS_DIR || path.join(HERE, '..', 'jobs')

/** Shared secret the calling account must present. Required: without it, anyone who can
 *  reach the port can run Claude Code on this machine. */
export const TOKEN = process.env.BRIDGE_TOKEN || ''

export const HOST = process.env.BRIDGE_HOST || '0.0.0.0'
export const PORT = Number(process.env.BRIDGE_PORT || 8790)

/** Working directory the delegated Claude runs in. */
export const DEFAULT_CWD =
  process.env.BRIDGE_CWD || path.join(homedir(), 'Desktop', 'Claude WorkSpace')

/** Permission posture for the delegated session. Deliberately not bypassPermissions:
 *  the caller is a remote party, and bypass would hand them unattended shell here.
 *  `auto` matches this machine's own interactive default. */
export const PERMISSION_MODE = process.env.BRIDGE_PERMISSION_MODE || 'auto'

/** Optional tool allowlist. Empty means every tool the session normally has. */
export const ALLOWED_TOOLS = (process.env.BRIDGE_ALLOWED_TOOLS || '').trim()

/** Model for delegated runs. Empty means the machine's configured default. */
export const MODEL = (process.env.BRIDGE_MODEL || '').trim()

/** Hard ceiling on a single delegated run, independent of how long the caller waits. */
export const JOB_TIMEOUT_MS = Number(process.env.BRIDGE_JOB_TIMEOUT_MS || 3_600_000)

/** Long-poll ceiling per tool call.
 *
 *  The binding constraint is the caller's IDLE clock, not its wall clock. The wall clock
 *  defaults to about 27.8 hours and has no documented maximum, but Claude Code aborts an
 *  HTTP server's call after 300s of silence unless the caller sets a per-server "timeout"
 *  or CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT. 240 keeps us safely under that with no config on
 *  the caller's side. Going higher means emitting progress notifications, which reset the
 *  idle clock, or requiring the caller to set a per-server timeout. */
export const MAX_WAIT_SECONDS = Number(process.env.BRIDGE_MAX_WAIT_SECONDS || 240)

/** Most delegated runs alive at once. This is not a limit on what a job may do, it stops
 *  a runaway caller from spawning Claude Code processes until the machine falls over. */
export const MAX_CONCURRENT_JOBS = Number(process.env.BRIDGE_MAX_CONCURRENT_JOBS || 6)

/** Cap on captured output per run. Only the JSON result object is ever used, so retaining
 *  an unbounded stream is pure memory risk. */
export const MAX_OUTPUT_BYTES = Number(process.env.BRIDGE_MAX_OUTPUT_BYTES || 32 * 1024 * 1024)

/** Retention sweep for finished jobs on disk. */
export const JOB_RETENTION_MS = Number(process.env.BRIDGE_JOB_RETENTION_MS || 7 * 24 * 3_600_000)

const CANDIDATE_BINS = [
  process.env.CLAUDE_BIN,
  path.join(
    homedir(),
    'AppData', 'Roaming', 'npm', 'node_modules',
    '@anthropic-ai', 'claude-code', 'bin', 'claude.exe',
  ),
  path.join(homedir(), '.local', 'bin', 'claude'),
  '/usr/local/bin/claude',
].filter(Boolean)

/** Resolve the real Claude Code executable so we never spawn through a shell. */
export function resolveClaudeBin() {
  for (const candidate of CANDIDATE_BINS) {
    if (existsSync(candidate)) return candidate
  }
  // Last resort: let the OS resolve it from PATH.
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

export function assertConfigured() {
  const problems = []
  if (!TOKEN) {
    problems.push('BRIDGE_TOKEN is not set (required)')
  } else if (TOKEN.length < 24) {
    problems.push('BRIDGE_TOKEN is too short, use at least 24 characters')
  }
  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    problems.push(`BRIDGE_PORT is invalid: ${process.env.BRIDGE_PORT}`)
  }
  if (PERMISSION_MODE === 'bypassPermissions') {
    problems.push(
      'BRIDGE_PERMISSION_MODE=bypassPermissions is refused: it would give the remote caller unattended shell on this machine',
    )
  }
  if (problems.length) {
    throw new Error(`claude-bridge is not configured:\n  - ${problems.join('\n  - ')}`)
  }
}
