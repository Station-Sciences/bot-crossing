/**
 * Harness adapter: OpenCode — sessions in a local SQLite database.
 *
 * Primary store is `opencode.db` (WAL mode, so concurrent readers are safe while
 * the app runs): `~/.local/share/opencode/opencode.db`, overridable with
 * `$OPENCODE_DB`. Only top-level sessions count as threads — child rows with
 * `parent_id` set are the task tool's subagents, and OpenCode's own session list
 * filters them the same way. Including them would stand hundreds of astronauts
 * on the map that nobody ever talked to.
 *
 * Read-only, without exception, and no subprocess anywhere. There is no
 * per-session deep link upstream, so opening a thread is honestly refused and
 * starting one goes through the registered `opencode://new-session` handler.
 */
import path from 'node:path'
import os from 'node:os'
import { exists, findExecutable, num } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/**
 * Where `opencode.db` lives. `$OPENCODE_DB` wins when it names a file that is
 * actually there — otherwise the XDG path, then the macOS Application Support
 * fallback on darwin only. Resolved per call so pointing the var at a fixture
 * (or installing the app) is picked up on the next poll.
 */
async function dbPath() {
  const override = process.env.OPENCODE_DB
  // When set, the override is the whole answer: a missing file means "absent",
  // not "fall back to the default and read a database the user did not name".
  // That is also what makes fixture tests isolate from the real store.
  if (typeof override === 'string' && override) return (await exists(override)) ? override : ''
  const xdg = process.env.XDG_DATA_HOME
  if (typeof xdg === 'string' && xdg) {
    const p = path.join(xdg, 'opencode', 'opencode.db')
    if (await exists(p)) return p
  }
  const shared = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db')
  if (await exists(shared)) return shared
  if (process.platform === 'darwin') {
    const mac = path.join(HOME, 'Library', 'Application Support', 'opencode', 'opencode.db')
    if (await exists(mac)) return mac
  }
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
const ID = (raw) => `opencode:${raw}`

/** OpenCode writes nothing when it is killed, so an open turn needs a time bound too. */
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
  // Both separators: a Windows directory arrives with either, and `basename`
  // on one OS must still read a path written on another (tests use posix).
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
 * Seen in the wild: `The user rejected permission to use this specific tool
 * call.` and `Tool execution aborted` — both are the user stopping the turn,
 * not the turn failing. Only a genuine failure reddens an astronaut.
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

/** One session row plus its derived facts, in the thread shape every harness hands the scanner. */
function toThread(r, prompt, facts) {
  const { projectPath, project, cwd } = projectOf(r.directory)
  const { model, effort } = parseModel(r.model)
  const title = clean(r.title) || prompt || 'Untitled thread'
  return {
    id: ID(r.id),
    title: title.slice(0, 120),
    preview: prompt.slice(0, 240),
    project,
    projectPath,
    // OpenCode has no worktree concept of its own, and guessing one from
    // the path would put a branch name on a thread that never had one.
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
    // across the whole map, and a token count would make OpenCode
    // buildings taller than Claude ones for the same work.
    sizeBytes: facts.sizeBytes,
    source: typeof r.agent === 'string' ? r.agent : '',
    canOpen: false,
    ref: { sessionId: r.id, cwd }
  }
}

/** The original store: `session`, with turns split across `message` and `part`. */
async function scanV1(db, tables) {
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
    const prompt = await firstUserText(db, r.id)
    const facts = await sessionFacts(db, r.id, num(r.time_updated))
    out.push(toThread(r, prompt, facts))
  }
  return out
}

/**
 * The 1.5 store: `session_v2`, with one `session_message` row per event — `user`
 * (its text inline), `assistant` (content inline, stamped `time.completed` when
 * the turn ends) and `idle` (the turn is over, with an `outcome`). New sessions
 * are written here only, so a 1.5 install leaves the old tables empty.
 */
async function firstUserTextV2(db, sessionId) {
  if (previewCache.has(sessionId)) return previewCache.get(sessionId)
  let out = ''
  try {
    const row = db
      .prepare(`SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq ASC LIMIT 1`)
      .get(sessionId)
    if (row?.data) out = clean(JSON.parse(row.data)?.text)
  } catch {
    out = ''
  }
  previewCache.set(sessionId, out)
  return out
}

async function sessionFactsV2(db, tables, r) {
  const timeUpdated = num(r.time_updated)
  const key = `v2:${r.id}`
  const hit = factsCache.get(key)
  if (hit && hit.timeUpdated === timeUpdated && hit.idle === r.time_idle) return hit.facts
  const facts = { running: false, hasError: false, sizeBytes: 0 }
  try {
    const m = db.prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM session_message WHERE session_id = ?`).get(r.id)
    facts.sizeBytes = num(m?.n)
    if (tables.has('session_part')) {
      const p = db.prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM session_part WHERE session_id = ?`).get(r.id)
      facts.sizeBytes += num(p?.n)
    }
  } catch {
    /* keep what was counted */
  }
  try {
    const last = db
      .prepare(
        `SELECT type, data FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant', 'idle') ORDER BY seq DESC LIMIT 1`
      )
      .get(r.id)
    let d = {}
    try {
      d = last?.data ? JSON.parse(last.data) : {}
    } catch {
      d = {}
    }
    const msgError = typeof d?.error?.name === 'string' ? d.error.name : ''
    // `time_busy` past `time_idle` is OpenCode's own "a turn is in flight"; the
    // trailing message is the fallback for a row that predates those columns.
    const busy = r.time_busy != null && (r.time_idle == null || num(r.time_busy) > num(r.time_idle))
    const open =
      last?.type === 'user' || (last?.type === 'assistant' && !d?.time?.completed && !d?.finish && !msgError)
    facts.running = (busy || open) && Date.now() - timeUpdated < ACTIVE_WINDOW_MS
    const outcome = typeof r.idle_outcome === 'string' ? r.idle_outcome : typeof d?.outcome === 'string' ? d.outcome : ''
    // An abort is the user pressing escape, not a failure — same rule as the old store.
    facts.hasError = (/error|fail/i.test(outcome) || Boolean(msgError)) && !/abort|cancel/i.test(`${outcome} ${msgError}`)
  } catch {
    /* mid-write, or gone */
  }
  factsCache.set(key, { timeUpdated, idle: r.time_idle, facts })
  return facts
}

async function scanV2(db, tables) {
  if (!tables.has('session_v2') || !tables.has('session_message')) return []
  const cols = new Set(db.prepare(`PRAGMA table_info(session_v2)`).all().map((r) => r.name))
  for (const need of ['id', 'directory', 'title', 'time_created', 'time_updated']) {
    if (!cols.has(need)) return []
  }
  const pick = (c) => (cols.has(c) ? c : `NULL AS ${c}`)
  const rows = db
    .prepare(
      `SELECT id, directory, title, ${['agent', 'model', 'time_archived', 'time_busy', 'time_idle', 'idle_outcome'].map(pick).join(', ')}, time_created, time_updated FROM session_v2 ${cols.has('parent_id') ? 'WHERE parent_id IS NULL' : ''} ORDER BY time_updated DESC`
    )
    .all()
  const out = []
  for (const r of rows) {
    if (typeof r.id !== 'string' || !r.id) continue
    const prompt = await firstUserTextV2(db, r.id)
    const facts = await sessionFactsV2(db, tables, r)
    out.push(toThread(r, prompt, facts))
  }
  return out
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
    // Each store is read on its own, so a drifted schema in one never costs the other.
    const out = await scanV1(db, tables).catch(() => [])
    const seen = new Set(out.map((t) => t.id))
    for (const t of await scanV2(db, tables).catch(() => [])) {
      if (!seen.has(t.id)) out.push(t)
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
 * OpenCode registers `opencode://open-project` and `opencode://new-session`
 * and nothing that addresses a single session — inventing a route would be a
 * link that silently does nothing. Revealing the session list is the honest
 * offer, and the UI greys the button and shows this instead.
 */
function openThread(ref) {
  const id = ref?.sessionId
  // The type check matters wherever an id came back from the page:
  // `String([validId])` is that id, and it must not travel on as an array.
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: 'No openable OpenCode session id on that thread' }
  }
  return {
    ok: false,
    error: 'OpenCode has no link to a single session — open the repo and pick it from the session list.'
  }
}

/**
 * Where the `opencode` CLI is, for a machine that needs the terminal fallback.
 * PATH first, then the places its installers put it — never inside an
 * application bundle. Only Linux asks: on macOS and Windows the deep link is
 * always answered, so the walk is wasted.
 */
const CLI_DIRS = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.opencode', 'bin'), '/usr/local/bin', '/usr/bin']
const cliBinary = () => findExecutable('opencode', CLI_DIRS)

async function newSession(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    return { ok: false, error: 'That folder is not somewhere OpenCode can open' }
  }
  const url = `opencode://new-session?${new URLSearchParams({ directory: dir })}`
  let command
  if (process.platform === 'linux') {
    const bin = await cliBinary()
    if (bin) command = { argv: [bin], cwd: dir }
  }
  return { ok: true, url, command }
}

async function detect() {
  return Boolean(await dbPath())
}

/**
 * Why a present OpenCode might still look thin. Without this the old-Node case
 * is invisible: the database is simply skipped, every thread is missing, and
 * nothing says why.
 */
async function diagnostic() {
  if (!(await dbPath())) return ''
  if (!(await sqliteApi())?.DatabaseSync) {
    return `OpenCode threads need Node 22.13 or newer for their sessions (running ${process.versions.node})`
  }
  return ''
}

export default {
  id: 'opencode',
  name: 'OpenCode',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: {}
}
