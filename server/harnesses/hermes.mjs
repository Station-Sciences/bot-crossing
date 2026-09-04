/**
 * Harness adapter: Hermes Agent — the terminal and chat apps' session store.
 *
 * Reads the agent's own session store — the `sessions` table in
 * `~/.hermes/state.db`, opened read-only — plus a first-user-message preview
 * per session. One SQL pass per scan; a 500-session store answers in
 * milliseconds, so no mtime cache is needed.
 *
 * Hermes sessions live in the terminal and chat apps, which have no deep
 * link to hand back: `openThread` / `newSession` say so per the interface
 * and the UI greys those buttons out. Archiving flips the harness's own
 * `archived` flag with a single atomic UPDATE, so the thread lands in
 * Hermes's archived list rather than only disappearing here.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()
const MAIN_DB = path.join(HOME, '.hermes', 'state.db')
const PROFILES_DIR = path.join(HOME, '.hermes', 'profiles')

/** Every bot that owns sessions: the default profile plus each named profile
 *  with its own session store. Pilot name doubles as the astronaut's identity. */
function pilotDBs() {
  const dbs = [{ pilot: 'main', file: MAIN_DB }]
  let dirs = []
  try {
    dirs = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
  } catch {
    return dbs
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const file = path.join(PROFILES_DIR, d.name, 'state.db')
    try {
      fs.accessSync(file, fs.constants.R_OK)
      dbs.push({ pilot: d.name, file })
    } catch {
      /* profile never ran — no astronaut until it has sessions */
    }
  }
  return dbs
}

const openRead = (file) => new DatabaseSync(file, { readOnly: true })

function toThread(row, pilot) {
  const root = row.git_repo_root || row.cwd || ''
  // Sessions run from the agent home (or with no cwd) are all the same
  // project — don't let basename case/dirname split one bot into many.
  const home = HOME
  const isHome = !root || root === home || root === home + '/.hermes'
  const project = isHome ? 'Hermes' : path.basename(root)
  // Keep projectPath canonical too: the colony keys plots on (name, path),
  // so three spellings of home would be re-split into three plots downstream.
  const projectPath = isHome ? home : root
  const createdAt = Math.round((row.started_at || 0) * 1000)
  const lastActivityAt = Math.round(((row.last_activity_at || row.ended_at || row.started_at) || 0) * 1000)
  const tokens = (row.input_tokens || 0) + (row.output_tokens || 0)
  return {
    id: `hermes:${pilot}:${row.id}`,
    pilot,
    title: row.title || 'Untitled thread',
    preview: (row.first_user || '').trim().slice(0, 280),
    project,
    projectPath,
    worktree: '',
    cwd: row.cwd || '',
    gitBranch: row.git_branch || '',
    model: row.model || '',
    effort: '',
    createdAt,
    lastActivityAt,
    lastFocusedAt: 0,
    running: row.ended_at == null,
    unread: Boolean(
      row.last_activity_at && row.last_read_at && row.last_activity_at > row.last_read_at
    ),
    hasError: false,
    archived: row.archived === 1,
    sizeBytes: tokens > 0 ? tokens * 4 : (row.message_count || 0) * 500,
    source: row.source || '',
    canOpen: false,
    canArchive: true,
    ref: { sessionId: row.id, pilot },
  }
}

async function detect() {
  try {
    openRead(MAIN_DB).close()
    return true
  } catch {
    return false
  }
}

const THREAD_SQL = `
      SELECT s.id, s.title, s.model, s.source, s.cwd, s.git_branch, s.git_repo_root,
             s.started_at, s.ended_at, s.message_count,
             s.input_tokens, s.output_tokens, s.archived,
             s.last_activity_at, s.last_read_at,
             (SELECT substr(m.content, 1, 280) FROM messages m
               WHERE m.session_id = s.id AND m.role = 'user' AND m.active = 1
               ORDER BY m.id ASC LIMIT 1) AS first_user
        FROM sessions s
       -- Cron executions are scheduled runs, not threads: each one would
       -- stand on the map as an astronaut nobody ever talks to. Skip them.
       WHERE s.hidden = 0 AND s.source != 'cron'
       ORDER BY COALESCE(s.last_activity_at, s.ended_at, s.started_at) DESC
`

async function scanThreads() {
  const out = []
  for (const { pilot, file } of pilotDBs()) {
    let db
    try {
      db = openRead(file)
    } catch {
      continue
    }
    try {
      for (const row of db.prepare(THREAD_SQL).all()) out.push(toThread(row, pilot))
    } finally {
      db.close()
    }
  }
  return out
}

function openThread() {
  return { ok: false, error: 'Hermes sessions live in the terminal and chat apps — there is no link to open.' }
}

function newSession() {
  return { ok: false, error: 'Hermes sessions start in the terminal, not from the colony.' }
}

async function setArchived(ref, archived) {
  const sessionId = ref && ref.sessionId
  if (!sessionId) return { ok: false, error: 'Missing thread ref' }
  const pilot = (ref && ref.pilot) || 'main'
  const found = pilotDBs().find((d) => d.pilot === pilot)
  if (!found) return { ok: false, error: 'No such pilot in the Hermes store' }
  try {
    const db = new DatabaseSync(found.file)
    try {
      const info = db.prepare('UPDATE sessions SET archived = ? WHERE id = ?')
        .run(archived ? 1 : 0, sessionId)
      return info.changes > 0
        ? { ok: true }
        : { ok: false, error: 'No such session in the Hermes store' }
    } finally {
      db.close()
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

export default {
  id: 'hermes',
  name: 'Hermes',
  detect,
  scanThreads,
  openThread,
  newSession,
  setArchived,
}
