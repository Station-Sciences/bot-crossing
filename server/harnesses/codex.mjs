/**
 * Harness adapter: Codex (OpenAI) — the desktop app, the VS Code extension and the CLI together.
 *
 * Two stores, deliberately merged rather than picked between, the same shape `claude-code.mjs`
 * ended up in:
 *
 *   - `~/.codex/state_<n>.sqlite` holds one row per thread — title, cwd, branch, model, effort,
 *     archived — which is everything the colony wants and none of it inferred.
 *   - `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` holds the transcript, which is the only
 *     source for how big a thread is and whether it is mid-turn, and the only source at all for
 *     a session the database has not caught up with.
 *
 * They join on the session id, which appears in the row, in the rollout's filename and in its
 * `session_meta` record. Reading only the database loses transcript size and any CLI session it
 * has not indexed; reading only the transcripts means reconstructing metadata the database
 * already has correct.
 *
 * Read-only, without exception, and the scan starts no subprocess. The only executable this
 * module ever names is the `codex` binary on the user's own PATH, handed to the server as an argv
 * for a terminal — nothing here runs anything. Codex has an archive of its own that only its CLI
 * can set, so archiving here is recorded in the colony alone — see the note on archiving in
 * `server/harnesses/README.md`.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, findExecutable, jsonLines, listDirs, listFiles, num, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex')
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions')
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl')

const HEAD_BYTES = 128 * 1024
const TAIL_BYTES = 64 * 1024
/** Codex writes nothing when it is killed, so a stale `task_started` needs a time bound too. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_DB = /^state_(\d+)\.sqlite$/

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `codex:${raw}`

/**
 * `node:sqlite` is imported lazily and its absence is survivable.
 *
 * It needs Node 22.13, which `package.json` asks for — but asking is not enforcing, and a top
 * level import would take the whole server down on an older Node rather than costing one
 * harness. This way the transcript half still works and `diagnostic()` explains the rest.
 */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/** The newest schema version, not the most recently touched WAL sibling. */
async function latestStateDatabase() {
  let entries
  try {
    entries = await fsp.readdir(CODEX_HOME, { withFileTypes: true })
  } catch {
    return ''
  }
  return (
    entries
      .filter((e) => e.isFile() && STATE_DB.test(e.name))
      .map((e) => ({ file: path.join(CODEX_HOME, e.name), version: Number(e.name.match(STATE_DB)[1]) }))
      .sort((a, b) => b.version - a.version)[0]?.file || ''
  )
}

/**
 * Every column is probed before it is named.
 *
 * This is undocumented private state that changes shape between Codex versions — the filename is
 * versioned precisely because it does. A `SELECT` naming a column that has gone throws and costs
 * the whole harness its threads, so anything not load-bearing is asked for only if it is there.
 */
const column = (columns, name, fallback = "''") => (columns.has(name) ? `t.${name}` : fallback)

function timeExpr(columns, ms, secs) {
  if (columns.has(ms) && columns.has(secs)) return `COALESCE(t.${ms}, t.${secs} * 1000)`
  if (columns.has(ms)) return `t.${ms}`
  if (columns.has(secs)) return `t.${secs} * 1000`
  return '0'
}

/** The thread index, keyed by session id. Empty when there is no readable database. */
async function databaseRows() {
  const [file, sqlite] = await Promise.all([latestStateDatabase(), sqliteApi()])
  if (!file || !sqlite?.DatabaseSync) return new Map()

  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
  } catch {
    // A WAL database whose shared-memory file cannot be used refuses a read-only open. The
    // transcripts still answer everything the colony needs to draw something.
    return new Map()
  }
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    )
    if (!tables.has('threads')) return new Map()
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name))
    if (!['id', 'cwd'].every((n) => columns.has(n))) return new Map()

    // Threads a task spawned are not conversations anybody had; each would stand on the map as
    // an astronaut nobody talks to.
    const children = new Set()
    if (tables.has('thread_spawn_edges')) {
      const edge = new Set(db.prepare('PRAGMA table_info(thread_spawn_edges)').all().map((r) => r.name))
      if (edge.has('child_thread_id')) {
        for (const r of db.prepare('SELECT child_thread_id FROM thread_spawn_edges').all()) {
          if (typeof r.child_thread_id === 'string') children.add(r.child_thread_id)
        }
      }
    }

    const rows = db
      .prepare(`
        SELECT
          t.id,
          t.cwd,
          ${column(columns, 'title')} AS title,
          ${column(columns, 'preview')} AS preview,
          ${column(columns, 'first_user_message')} AS first_user_message,
          ${column(columns, 'source')} AS source,
          ${column(columns, 'thread_source')} AS thread_source,
          ${column(columns, 'git_branch')} AS git_branch,
          ${column(columns, 'model')} AS model,
          ${column(columns, 'reasoning_effort')} AS reasoning_effort,
          ${column(columns, 'rollout_path')} AS rollout_path,
          ${column(columns, 'archived', '0')} AS archived,
          ${timeExpr(columns, 'created_at_ms', 'created_at')} AS created_at_ms,
          ${timeExpr(columns, 'updated_at_ms', 'updated_at')} AS updated_at_ms
        FROM threads t
      `)
      .all()
      .filter((r) => UUID.test(r.id || '') && !children.has(r.id) && r.thread_source !== 'subagent')

    return new Map(rows.map((r) => [r.id, r]))
  } catch {
    return new Map()
  } finally {
    try {
      db.close()
    } catch {
      /* already gone */
    }
  }
}

/** Every rollout transcript on disk, keyed by the session id in its filename. */
async function scanRollouts() {
  const byId = new Map()
  for (const year of await listDirs(SESSIONS_DIR)) {
    for (const month of await listDirs(year)) {
      for (const day of await listDirs(month)) {
        for (const file of await listFiles(day, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
          const id = /([0-9a-f-]{36})\.jsonl$/i.exec(file)?.[1]
          if (!id || !UUID.test(id)) continue
          try {
            const st = await fsp.stat(file)
            byId.set(id, { id, file, size: st.size, mtime: st.mtimeMs })
          } catch {
            /* vanished between listing and stat */
          }
        }
      }
    }
  }
  return byId
}

/** `thread_name` per session, when Codex has written one. Optional; transcripts are the truth. */
async function readIndex() {
  const out = new Map()
  try {
    for (const row of jsonLines(await fsp.readFile(SESSION_INDEX, 'utf8'))) {
      if (row?.id && UUID.test(row.id)) out.set(row.id, row)
    }
  } catch {
    /* no index — every field it carries has another source */
  }
  return out
}

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p === 'string' ? p : p?.text || p?.input_text || '')).filter(Boolean).join('\n')
}

/** What the head of a transcript knows about itself, for a session the database has not indexed. */
function readHeadMeta(records) {
  const meta = { cwd: '', gitBranch: '', model: '', effort: '', createdAt: 0, prompt: '' }
  for (const r of records) {
    const p = r?.payload
    if (!p || typeof p !== 'object') continue
    if (r.type === 'session_meta') {
      meta.cwd ||= p.cwd || ''
      meta.gitBranch ||= p.git?.branch || ''
      meta.createdAt ||= Date.parse(p.timestamp || r.timestamp || '') || 0
    } else if (r.type === 'turn_context') {
      meta.cwd = p.cwd || meta.cwd
      meta.model = p.model || meta.model
      meta.effort = p.effort || meta.effort
    } else if (r.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      meta.prompt ||= clean(contentText(p.content))
    }
  }
  return meta
}

/**
 * The last lifecycle record. `task_started` with nothing after it is mid-turn; `turn_aborted` is
 * somebody pressing escape, which is not an error and must not redden an astronaut's eyes.
 */
function readLifecycle(records) {
  let last = null
  for (const r of records) {
    const p = r?.payload
    if (r?.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(p?.type)) {
      last = { type: p.type, error: Boolean(p.error) }
    }
  }
  return last
}

/** Parsing is kept against mtime and size, so an unchanged transcript is read once. */
const parseCache = new Map()
async function transcriptFacts(entry, needHead) {
  const cached = parseCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime && cached.size === entry.size && (cached.head || !needHead)) {
    return cached.facts
  }
  const facts = { lifecycle: null, meta: null }
  try {
    facts.lifecycle = readLifecycle(jsonLines(await readTail(entry.file, TAIL_BYTES)))
    if (needHead) facts.meta = readHeadMeta(jsonLines(await readHead(entry.file, HEAD_BYTES)))
  } catch {
    /* mid-write, or gone */
  }
  parseCache.set(entry.id, { mtime: entry.mtime, size: entry.size, head: needHead, facts })
  return facts
}

function projectOf(cwd) {
  const dir = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : ''
  return { projectPath: dir, project: dir ? path.basename(dir) : 'unknown' }
}

async function scanThreads() {
  const [rows, rollouts, index] = await Promise.all([databaseRows(), scanRollouts(), readIndex()])
  const ids = new Set([...rows.keys(), ...rollouts.keys()])
  const now = Date.now()
  const out = []

  for (const id of ids) {
    const row = rows.get(id)
    const entry = rollouts.get(id)
    // The head is only worth reading for a session the database cannot describe.
    const facts = entry ? await transcriptFacts(entry, !row) : { lifecycle: null, meta: null }
    const meta = facts.meta || {}

    const cwd = row?.cwd || meta.cwd || ''
    const { projectPath, project } = projectOf(cwd)
    const prompt = clean(row?.preview || row?.first_user_message || meta.prompt || '')
    const title = clean(row?.title) || clean(index.get(id)?.thread_name) || prompt || 'Untitled thread'
    const lastActivityAt = Math.max(num(row?.updated_at_ms), entry?.mtime || 0)

    out.push({
      id: ID(id),
      title: title.slice(0, 120),
      preview: prompt.slice(0, 240),
      project,
      projectPath,
      // Codex has no worktree concept of its own, and guessing one from the path would put a
      // branch name on a thread that never had one.
      worktree: '',
      cwd,
      gitBranch: row?.git_branch || meta.gitBranch || '',
      model: row?.model || meta.model || '',
      effort: row?.reasoning_effort || meta.effort || '',
      createdAt: num(row?.created_at_ms) || meta.createdAt || entry?.mtime || 0,
      lastActivityAt,
      // Codex records no focus history, so "have you looked at this" is unknowable — not false.
      lastFocusedAt: 0,
      unread: false,
      running: facts.lifecycle?.type === 'task_started' && now - lastActivityAt < ACTIVE_WINDOW_MS,
      hasError: facts.lifecycle?.type === 'task_complete' && facts.lifecycle.error,
      starred: false,
      routine: '',
      prState: '',
      archived: row?.archived === 1 || row?.archived === true,
      // Bytes, like every other harness: the field is a shared log scale across the whole map,
      // and a token count would make Codex buildings taller than Claude ones for the same work.
      sizeBytes: entry?.size || 0,
      source: row?.source === 'vscode' ? 'vscode' : 'cli',
      canOpen: true,
      ref: { sessionId: id, cwd },
    })
  }
  return out
}

/**
 * Where the `codex` CLI is, for a page that would rather have a terminal than the app. PATH
 * first, then the places `npm i -g` and Homebrew put a binary that a server started from a
 * launcher would not see — never inside an application bundle.
 */
const CLI_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
]
const cliBinary = () => findExecutable('codex', CLI_DIRS)

/**
 * `codex://threads/<id>` is registered by the Codex desktop app; the OS opener does the rest.
 * `codex resume <id>` is the CLI's own way back into the same session, offered alongside for a
 * page that prefers a terminal. Nothing is run here — the server decides whether it is.
 */
async function openThread(ref) {
  const { sessionId: id, cwd } = ref || {}
  if (typeof id !== 'string' || !UUID.test(id)) {
    return { ok: false, error: 'No openable Codex session id on that thread' }
  }
  const bin = await cliBinary()
  const command = bin ? { argv: [bin, 'resume', id], cwd: typeof cwd === 'string' ? cwd : '' } : undefined
  return { ok: true, url: `codex://threads/${id}`, command }
}

async function newSession(dir) {
  const bin = await cliBinary()
  return {
    ok: true,
    url: `codex://threads/new?${new URLSearchParams({ path: dir })}`,
    command: bin ? { argv: [bin], cwd: dir } : undefined,
  }
}

/** Claim the machine if either store is there — a CLI-only install has no database. */
async function detect() {
  return (await exists(SESSIONS_DIR)) || Boolean(await latestStateDatabase())
}

/**
 * Why a present Codex might still look thin. Without this the Node case is invisible: the
 * database is simply skipped, every thread loses its title and model, and nothing says why.
 */
async function diagnostic() {
  if (!(await latestStateDatabase())) return ''
  if (!(await sqliteApi())?.DatabaseSync) {
    return `Codex threads need Node 22.13 or newer for their titles and models (running ${process.versions.node})`
  }
  return ''
}

export default {
  id: 'codex',
  name: 'Codex',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: { CODEX_HOME, SESSIONS_DIR },
}
