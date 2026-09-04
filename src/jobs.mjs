import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { JOBS_DIR, JOB_RETENTION_MS } from './config.mjs'

export const TERMINAL_STATES = new Set(['done', 'error', 'cancelled', 'timeout'])

const jobs = new Map()
const events = new EventEmitter()
// Every job that is waited on adds a listener; the default cap of 10 is far too low.
events.setMaxListeners(0)

fs.mkdirSync(JOBS_DIR, { recursive: true })

function jobFile(id) {
  return path.join(JOBS_DIR, `${id}.json`)
}

function persist(job) {
  try {
    fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2))
  } catch (err) {
    console.error(`[jobs] could not persist ${job.id}: ${err.message}`)
  }
}

/** Reload finished jobs from disk so a server restart does not lose results. */
export function loadPersistedJobs() {
  let loaded = 0
  for (const entry of fs.readdirSync(JOBS_DIR)) {
    if (!entry.endsWith('.json')) continue
    try {
      const job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, entry), 'utf8'))
      // A job still marked running cannot survive the restart that killed its child.
      if (!TERMINAL_STATES.has(job.status)) {
        job.status = 'error'
        job.error = 'The bridge restarted while this job was running.'
        job.finished_at = job.finished_at || new Date().toISOString()
        persist(job)
      }
      jobs.set(job.id, job)
      loaded += 1
    } catch (err) {
      console.error(`[jobs] skipping unreadable ${entry}: ${err.message}`)
    }
  }
  return loaded
}

export function createJob({ prompt, cwd, resumeSessionId, model, effort, allowedTools, permissionMode }) {
  const job = {
    id: randomUUID(),
    status: 'running',
    prompt,
    cwd,
    resume_session_id: resumeSessionId || null,
    // Caller-chosen worker settings. The runner checks each against a fixed vocabulary
    // before any of them reaches argv.
    model: model || null,
    effort: effort || null,
    allowed_tools: allowedTools || null,
    permission_mode: permissionMode || null,
    session_id: null,
    result: null,
    error: null,
    cost_usd: null,
    duration_ms: null,
    num_turns: null,
    created_at: new Date().toISOString(),
    finished_at: null,
  }
  jobs.set(job.id, job)
  persist(job)
  return job
}

export function getJob(id) {
  return jobs.get(id) || null
}

export function updateJob(id, patch) {
  const job = jobs.get(id)
  if (!job) return null
  Object.assign(job, patch)
  if (TERMINAL_STATES.has(job.status) && !job.finished_at) {
    job.finished_at = new Date().toISOString()
  }
  persist(job)
  if (TERMINAL_STATES.has(job.status)) events.emit(`done:${id}`, job)
  return job
}

export function listJobs(limit = 20) {
  return [...jobs.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
}

/**
 * Resolve once the job reaches a terminal state, or after `waitMs`.
 * Returns the job either way; the caller checks `status` to tell them apart.
 */
export function waitForTerminal(id, waitMs) {
  const job = jobs.get(id)
  if (!job) return Promise.resolve(null)
  if (TERMINAL_STATES.has(job.status) || waitMs <= 0) return Promise.resolve(job)

  return new Promise((resolve) => {
    let timer = null
    const onDone = (finished) => {
      clearTimeout(timer)
      resolve(finished)
    }
    events.once(`done:${id}`, onDone)
    timer = setTimeout(() => {
      events.off(`done:${id}`, onDone)
      resolve(jobs.get(id))
    }, waitMs)
  })
}

/** Drop finished jobs older than the retention window, from memory and disk. */
export function sweepOldJobs(now = Date.now()) {
  let removed = 0
  for (const job of [...jobs.values()]) {
    if (!TERMINAL_STATES.has(job.status)) continue
    const finishedAt = Date.parse(job.finished_at || job.created_at)
    if (Number.isNaN(finishedAt) || now - finishedAt < JOB_RETENTION_MS) continue
    jobs.delete(job.id)
    try {
      fs.rmSync(jobFile(job.id), { force: true })
    } catch (err) {
      console.error(`[jobs] could not remove ${job.id}: ${err.message}`)
    }
    removed += 1
  }
  return removed
}
