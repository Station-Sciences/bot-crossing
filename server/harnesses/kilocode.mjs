/**
 * Harness adapter: Kilo Code — sessions in a local SQLite database.
 *
 * The current extension (rebuilt on the OpenCode server) keeps everything in
 * `kilo.db` (WAL mode, so concurrent readers are safe while the app runs):
 * `~/.local/share/kilo/kilo.db` on every OS, overridable with `$KILO_DB`.
 * Only top-level sessions count as threads — child rows with `parent_id` set
 * are the task tool's subagents, and Kilo's own history filters them the same
 * way. Including them would stand hundreds of astronauts on the map that
 * nobody ever talked to.
 *
 * The pre-rebuild extension kept per-task directories under VS Code's
 * `globalStorage/kilocode.kilo-code/tasks/` instead. That store is not read:
 * no install observed here still writes it, and guessing at its shape would
 * be worse than leaving it out and saying so.
 *
 * Read-only, without exception, and no subprocess anywhere. The extension
 * registers no URI handler for a single session, so opening a thread is
 * honestly refused and starting one reveals the repo folder in VS Code,
 * where the Kilo sidebar lives.
 */
import path from 'node:path'
import os from 'node:os'
import { exists, num } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/**
 * Where `kilo.db` lives. `$KILO_DB` wins when it names a file that is
 * actually there — otherwise the XDG path, then the fixed default the docs
 * give for every OS (including `%USERPROFILE%\.local\share\kilo\kilo.db` on
 * Windows). Resolved per call so pointing the var at a fixture (or
 * installing the app) is picked up on the next poll.
 */
async function dbPath() {
  const override = process.env.KILO_DB
  // When set, the override is the whole answer: a missing file means "absent",
  // not "fall back to the default and read a database the user did not name".
  // That is also what makes fixture tests isolate from the real store.
  if (typeof override === 'string' && override) return (await exists(override)) ? override : ''
  const xdg = process.env.XDG_DATA_HOME
  if (typeof xdg === 'string' && xdg) {
    const p = path.join(xdg, 'kilo', 'kilo.db')
    if (await exists(p)) return p
  }
  const shared = path.join(HOME, '.local', 'share', 'kilo', 'kilo.db')
  if (await exists(shared)) return shared
  return ''
}

/**
 * `node:sqlite` is imported lazily and its absence is survivable.
 *
 * It needs Node 22.13, which `package.json` asks for — but asking is not
 * enforcing, and a top level import would take the whole server down on an
 * older Node rather than costing one harness. This way every other harness
 * keeps working and `diagnostic()` explains the gap.
 */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `kilocode:${raw}`

/** Kilo writes nothing when it is killed, so an open turn needs a time bound too. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

function parseModel(raw) {
  if (!raw) return { model: '', effort: '' }
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      model: typeof m?.id === 'string' ? m.id : '',
      effort: typeof m?.variant === 'string' ? m.variant : ''
    }
  } catch {
    return { model: '', effort: '' }
  }
}

function projectOf(directory) {
  const dir = typeof directory === 'string' ? directory : ''
  if (!dir) return { projectPath: '', project: 'unknown', cwd: '' }
  // Both separators: a Windows directory arrives with forward slashes in this
  // store, and `basename` on one OS must still read a path written on another.
  const base = path.basename(dir.replace(/\\/g, '/'))
  return { projectPath: dir, project: base || 'unknown', cwd: dir }
}

/** First user text per session never changes, so it is kept forever. */
const previewCache = new Map()

async function firstUserText(db, sessionId) {
  if (previewCache.has(sessionId)) return previewCache.get(sessionId)
  let out = ''
  try {
    const msgs = db
      .prepare(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC LIMIT 8`)
      .all(sessionId)
    for (const m of msgs) {
      let role = ''
      try {
        role = JSON.parse(m.data)?.role || ''
      } catch {
        continue
      }
      if (role !== 'user') continue
      const parts = db
        .prepare(`SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC LIMIT 8`)
        .all(m.id)
      for (const p of parts) {
        try {
          const d = JSON.parse(p.data)
          if (d?.type === 'text' && typeof d.text === 'string' && clean(d.text)) {
            out = clean(d.text)
            break
          }
        } catch {
          /* a part mid-write — skip it */
        }
      }
      if (out) break
    }
  } catch {
    out = ''
  }
  previewCache.set(sessionId, out)
  return out
}

/** Costly facts kept against `time_updated`, so an unchanged session is read once. */
const factsCache = new Map()

/**
 * Whether an error-status tool part means the run failed.
 *
 * The user stopping the turn is not the turn failing — only a genuine failure
 * reddens an astronaut.
 */
function isRealError(raw) {
  let text = ''
  try {
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw
    const state = d?.state || {}
    text = `${state.error || ''}\n${state.output || ''}`
  } catch {
    return true
  }
  return !/user rejected permission|permission.{0,20}denied|denied.{0,20}permission|execution aborted|aborted|cancelled/i.test(text)
}

async function sessionFacts(db, sessionId, timeUpdated) {
  const hit = factsCache.get(sessionId)
  if (hit && hit.timeUpdated === timeUpdated) return hit.facts
  const facts = { running: false, hasError: false, sizeBytes: 0 }
  try {
    const msgBytes = db.prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM message WHERE session_id = ?`).get(sessionId)
    const partBytes = db.prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM part WHERE session_id = ?`).get(sessionId)
    facts.sizeBytes = num(msgBytes?.n) + num(partBytes?.n)
  } catch {
    facts.sizeBytes = 0
  }
  try {
    const last = db
      .prepare(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, rowid DESC LIMIT 1`)
      .get(sessionId)
    if (last?.data) {
      const d = JSON.parse(last.data)
      const completed = d?.time?.completed
      const finished = typeof d?.finish === 'string' && d.finish
      const msgError = typeof d?.error?.name === 'string' ? d.error.name : ''
      const aborted = /abort/i.test(msgError)
      // A trailing user message means the model speaks next — whatever the
      // process is doing, it is not waiting on anyone. A turn that ended in
      // error or abort is over too, even when it carries no finish stamp.
      const open = d?.role === 'user' || (d?.role === 'assistant' && !completed && !finished && !msgError)
      facts.running = open && Date.now() - num(timeUpdated) < ACTIVE_WINDOW_MS
      if (d?.role === 'assistant' && (completed || finished || msgError)) {
        if (aborted) {
          // The user stopped the turn. Same as pressing escape elsewhere:
          // an abandoned turn is not a failed one.
          facts.hasError = false
        } else if (msgError) {
          // The turn itself failed (provider/auth error) — that is what the
          // red eyes are for, even when no single tool part takes the blame.
          facts.hasError = true
        } else {
          // Only the last turn counts: a historic tool error must not redden
          // an astronaut forever. And a turn the *user* stopped is not a
          // failure — a rejected permission or an aborted call is this
          // harness's version of pressing escape.
          const candidates = db
            .prepare(
              `SELECT data FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 3) AND data LIKE '%"status":"error"%' LIMIT 5`
            )
            .all(sessionId)
          facts.hasError = candidates.some((row) => isRealError(row?.data))
        }
      }
    }
  } catch {
    /* mid-write, or gone */
  }
  factsCache.set(sessionId, { timeUpdated, facts })
  return facts
}

async function scanThreads() {
  const file = await dbPath()
  if (!file) return []
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) return []

  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
  } catch {
    // A WAL database whose shared-memory file cannot be used refuses a
    // read-only open. Losing one harness beats losing the scan.
    return []
  }
  try {
    const tables = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name)
    )
    if (!tables.has('session') || !tables.has('message') || !tables.has('part')) return []
    // Undocumented private state that drifts between versions — probe every
    // column before naming it, or one renamed column costs the whole harness.
    const cols = new Set(db.prepare(`PRAGMA table_info(session)`).all().map((r) => r.name))
    for (const need of ['id', 'directory', 'title', 'time_created', 'time_updated']) {
      if (!cols.has(need)) return []
    }
    const rows = db
      .prepare(
        `SELECT id, directory, title, agent, model, time_created, time_updated, time_archived FROM session ${cols.has('parent_id') ? 'WHERE parent_id IS NULL' : ''} ORDER BY time_updated DESC`
      )
      .all()
    const out = []
    for (const r of rows) {
      if (typeof r.id !== 'string' || !r.id) continue
      const { projectPath, project, cwd } = projectOf(r.directory)
      const { model, effort } = parseModel(r.model)
      const prompt = await firstUserText(db, r.id)
      const title = clean(r.title) || prompt || 'Untitled thread'
      const facts = await sessionFacts(db, r.id, num(r.time_updated))
      out.push({
        id: ID(r.id),
        title: title.slice(0, 120),
        preview: prompt.slice(0, 240),
        project,
        projectPath,
        // Kilo has no worktree concept of its own, and guessing one from the
        // path would put a branch name on a thread that never had one.
        worktree: '',
        cwd,
        gitBranch: '',
        model,
        effort,
        createdAt: num(r.time_created),
        lastActivityAt: num(r.time_updated),
        // No focus history, so "have you looked at this" is unknowable — not false.
        lastFocusedAt: 0,
        unread: false,
        running: facts.running,
        hasError: facts.hasError,
        starred: false,
        routine: '',
        prState: '',
        archived: r.time_archived !== null && r.time_archived !== undefined,
        // Bytes, like every other harness: the field is a shared log scale
        // across the whole map, and a token count would make Kilo buildings
        // taller than Claude ones for the same work.
        sizeBytes: facts.sizeBytes,
        source: typeof r.agent === 'string' ? r.agent : '',
        canOpen: false,
        ref: { sessionId: r.id, cwd }
      })
    }
    return out
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * The extension registers no URI handler for a single session — inventing a
 * route would be a link that silently does nothing. Revealing the session
 * list is the honest offer, and the UI greys the button and shows this instead.
 */
function openThread(ref) {
  const id = ref?.sessionId
  // The type check matters wherever an id came back from the page:
  // `String([validId])` is that id, and it must not travel on as an array.
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: 'No openable Kilo Code session id on that thread' }
  }
  return {
    ok: false,
    error: 'Kilo Code has no link to a single session — open the repo and pick it from the session list.'
  }
}

/**
 * `vscode://file/<path>` is answered by VS Code itself, where the Kilo
 * sidebar lives — the same offer the Cursor adapter makes with its own
 * scheme. `encodeURI` keeps the drive colon and the separators while
 * escaping the spaces a repo path usually carries.
 */
function newSession(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    return { ok: false, error: 'That folder is not somewhere Kilo Code can open' }
  }
  const url = `vscode://file/${encodeURI(dir.replace(/\\/g, '/'))}`
  return { ok: true, url }
}

async function detect() {
  return Boolean(await dbPath())
}

/**
 * Why a present Kilo Code might still look thin. Without this the old-Node case
 * is invisible: the database is simply skipped, every thread is missing, and
 * nothing says why.
 */
async function diagnostic() {
  if (!(await dbPath())) return ''
  if (!(await sqliteApi())?.DatabaseSync) {
    return `Kilo Code threads need Node 22.13 or newer for their sessions (running ${process.versions.node})`
  }
  return ''
}

export default {
  id: 'kilocode',
  name: 'Kilo Code',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: {}
}
