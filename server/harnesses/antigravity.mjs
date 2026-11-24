/**
 * Harness adapter: Antigravity (Google) — the CLI and the desktop app.
 *
 * Both keep sessions under `<home>/brain/<sessionId>/`, with the transcript at
 * `.system_generated/logs/transcript.jsonl` or `transcript.jsonl` inside the session directory.
 * They differ only in the home: `~/.gemini/antigravity-cli` for the CLI, `~/.gemini/antigravity`
 * for the app. Both are read, so a machine with either — or both — gets every conversation.
 *
 * Read-only, no subprocess, and no modifications to harness files.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, readHead, readTail, findExecutable } from '../lib/fsutil.mjs'

const HOME = os.homedir()
/**
 * Every home to read. An explicit override is the whole list, which is how the tests fake an
 * install. `source` is what the thread reports: the app's sessions are `desktop`, the CLI's `cli`.
 */
const OVERRIDE = process.env.BOT_CROSSING_ANTIGRAVITY_HOME || process.env.ANTIGRAVITY_HOME
const HOMES = OVERRIDE
  ? [{ dir: OVERRIDE, source: 'cli' }]
  : [
      { dir: path.join(HOME, '.gemini', 'antigravity-cli'), source: 'cli' },
      { dir: path.join(HOME, '.gemini', 'antigravity'), source: 'desktop' },
    ]
const ANTIGRAVITY_HOME = HOMES[0].dir
const BRAIN_DIR = path.join(ANTIGRAVITY_HOME, 'brain')

const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 32 * 1024
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `antigravity:${raw}`

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (typeof p === 'string' ? p : p?.text || p?.input_text || ''))
    .filter(Boolean)
    .join('\n')
}

/** Extract user query text from prompt/input record. */
function userText(record) {
  const raw = contentText(record?.content || record?.message?.content || '')
  // Strip XML-like wrapper tags if present
  const query = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw)
  const text = query ? query[1] : raw.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/gi, ' ')
  return clean(text)
}

/** Try to extract workspace/cwd from prompt user_information tags if present. */
function extractCwd(text) {
  const m = /active workspaces, each defined by a URI[\s\S]*?\[(.*?)\]\s*->/i.exec(text)
  if (m && path.isAbsolute(m[1])) return m[1]
  return ''
}

/**
 * Where each conversation ran. A transcript usually does not say, so most sessions arrived with
 * no folder at all and shared one zone called "unknown". The CLI's prompt history beside `brain/`
 * does: every prompt typed is a line of `{ display, timestamp, workspace, conversationId }`. Older
 * lines carry no conversation id, so not every session is covered — those stay unknown rather
 * than being guessed from whichever files the session happened to read.
 *
 * The folder a conversation started in wins. Re-read only when the file changes.
 */
const historyCache = new Map()
async function workspaces(home) {
  const file = path.join(home, 'history.jsonl')
  const st = await fsp.stat(file).catch(() => null)
  if (!st) return new Map()
  const history = historyCache.get(file)
  if (history && st.mtimeMs === history.mtime) return history.workspaces
  const out = new Map()
  try {
    for (const r of jsonLines(await fsp.readFile(file, 'utf8'))) {
      const id = r?.conversationId
      const dir = r?.workspace
      if (typeof id === 'string' && typeof dir === 'string' && path.isAbsolute(dir) && !out.has(id)) out.set(id, dir)
    }
  } catch {
    /* mid-write, or gone */
  }
  historyCache.set(file, { mtime: st.mtimeMs, workspaces: out })
  return out
}

/**
 * The desktop app's own index, `conversation_summaries.db`: one row per conversation with the
 * title it shows, the workspace it was opened on, and whether it is running. The app writes no
 * `history.jsonl`, and its transcripts do not name a folder, so without this every app session
 * lands in "unknown" under its first prompt instead of where you were working.
 *
 * Opened read-only and closed straight away. `node:sqlite` is imported lazily, as in
 * `opencode.mjs`, so a Node without it loses the titles and folders rather than the harness.
 * Cached against the database *and* its WAL: the app writes in WAL mode, where a change can sit
 * in `-wal` for a while without the main file's mtime moving.
 */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))
const summaryCache = new Map()

function folderOfUris(raw) {
  try {
    for (const uri of JSON.parse(raw)) {
      if (typeof uri !== 'string' || !uri.startsWith('file://')) continue
      const dir = decodeURIComponent(new URL(uri).pathname)
      if (path.isAbsolute(dir)) return dir
    }
  } catch {
    /* not the JSON list it usually is */
  }
  return ''
}

const timeOf = (v) => {
  const t = Date.parse(String(v || '').replace(' ', 'T'))
  return Number.isNaN(t) ? 0 : t
}

async function summaries(home) {
  const file = path.join(home, 'conversation_summaries.db')
  const [db, wal] = await Promise.all([fsp.stat(file).catch(() => null), fsp.stat(`${file}-wal`).catch(() => null)])
  if (!db) return new Map()
  const stamp = `${db.mtimeMs}:${db.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`
  const hit = summaryCache.get(file)
  if (hit?.stamp === stamp) return hit.rows

  const rows = new Map()
  const sqlite = await sqliteApi()
  if (sqlite?.DatabaseSync) {
    let handle
    try {
      handle = new sqlite.DatabaseSync(file, { readOnly: true })
      // Private state that drifts between versions: probe the columns before naming them.
      const cols = new Set(handle.prepare(`PRAGMA table_info(conversation_summaries)`).all().map((r) => r.name))
      if (cols.has('conversation_id')) {
        const want = ['title', 'workspace_uris', 'status', 'killed', 'last_modified_time', 'parent_conversation_id']
        const pick = want.filter((c) => cols.has(c))
        const sql = `SELECT conversation_id${pick.map((c) => `, ${c}`).join('')} FROM conversation_summaries`
        for (const r of handle.prepare(sql).all()) {
          if (typeof r.conversation_id !== 'string') continue
          rows.set(r.conversation_id, {
            title: clean(r.title),
            cwd: folderOfUris(r.workspace_uris),
            status: String(r.status || ''),
            killed: Boolean(Number(r.killed)),
            updatedAt: timeOf(r.last_modified_time),
            child: Boolean(r.parent_conversation_id),
          })
        }
      }
    } catch {
      /* locked mid-checkpoint, or a shape this does not know: try again next poll */
      return hit?.rows ?? rows
    } finally {
      try {
        handle?.close()
      } catch {
        /* already closed */
      }
    }
  }
  summaryCache.set(file, { stamp, rows })
  return rows
}

async function findTranscriptFile(sessionDir) {
  const candidates = [
    path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(sessionDir, 'transcript.jsonl'),
  ]
  for (const c of candidates) {
    if (await exists(c)) return c
  }
  return null
}

async function scanTranscripts(home) {
  const out = []
  for (const sessionDir of await listDirs(path.join(home, 'brain'))) {
    const id = path.basename(sessionDir)
    if (!UUID.test(id)) continue
    const file = await findTranscriptFile(sessionDir)
    if (!file) continue
    try {
      const st = await fsp.stat(file)
      if (!st.size) continue
      out.push({
        id,
        file,
        sessionDir,
        size: st.size,
        mtime: st.mtimeMs,
        born: st.birthtimeMs,
      })
    } catch {
      /* vanished */
    }
  }
  return out
}

const parseCache = new Map()
async function facts(entry) {
  const hit = parseCache.get(entry.id)
  if (hit && hit.mtime === entry.mtime && hit.size === entry.size) return hit.value

  const value = { prompt: '', cwd: '', startedAt: 0, closed: true, errored: false }
  try {
    for (const r of jsonLines(await readHead(entry.file, HEAD_BYTES))) {
      if (r?.type === 'USER_INPUT' || r?.role === 'user' || r?.source === 'USER_EXPLICIT') {
        const text = userText(r)
        if (!value.prompt && text) value.prompt = text
        const rawContent = String(r?.content || '')
        if (!value.cwd) value.cwd = r?.cwd || extractCwd(rawContent) || ''
        if (!value.startedAt && r?.created_at) {
          const t = Date.parse(r.created_at)
          if (!Number.isNaN(t)) value.startedAt = t
        }
        if (value.prompt && value.cwd && value.startedAt) break
      }
    }

    const tail = jsonLines(await readTail(entry.file, TAIL_BYTES))
    if (tail.length > 0) {
      const last = tail[tail.length - 1]
      value.errored = last?.status === 'ERROR' || Boolean(last?.error)
      value.closed = last?.status === 'DONE' || last?.status === 'COMPLETED' || last?.type === 'DONE'
    }
  } catch {
    /* mid-write, or vanished */
  }

  parseCache.set(entry.id, { mtime: entry.mtime, size: entry.size, value })
  return value
}

/**
 * Whether a conversation is stopped on you: a step waiting for approval, such as reading a file
 * outside the workspace or running a command. The summary index cannot say — it keeps reporting
 * `RUNNING` the whole time — and the transcript only has steps that finished. The app's own
 * per-conversation database, `conversations/<id>.db`, has every step with a numeric status;
 * finished steps are 3, queued ones 1, and the one sitting on Allow/Deny is 9.
 *
 * That 9 is read off a real app session, not a published enum, so only the newest few steps are
 * looked at and only for conversations that claim to be running. Read-only, closed straight
 * away, and cached against the database and its WAL.
 */
const STEP_AWAITING_USER = 9
const approvalCache = new Map()

async function awaitingApproval(home, id) {
  if (!UUID.test(id)) return false
  const file = path.join(home, 'conversations', `${id}.db`)
  const [db, wal] = await Promise.all([fsp.stat(file).catch(() => null), fsp.stat(`${file}-wal`).catch(() => null)])
  if (!db) return false
  const stamp = `${db.mtimeMs}:${db.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`
  const hit = approvalCache.get(file)
  if (hit?.stamp === stamp) return hit.waiting

  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) return false
  let handle
  let waiting = false
  try {
    handle = new sqlite.DatabaseSync(file, { readOnly: true })
    const cols = new Set(handle.prepare(`PRAGMA table_info(steps)`).all().map((r) => r.name))
    if (cols.has('idx') && cols.has('status')) {
      const recent = handle.prepare(`SELECT status FROM steps ORDER BY idx DESC LIMIT 20`).all()
      waiting = recent.some((r) => Number(r.status) === STEP_AWAITING_USER)
    }
  } catch {
    return hit?.waiting ?? false
  } finally {
    try {
      handle?.close()
    } catch {
      /* already closed */
    }
  }
  approvalCache.set(file, { stamp, waiting })
  return waiting
}

/**
 * A summary row's status is the app saying outright whether it is working, which beats guessing
 * from the transcript's last line. Only the words are trusted, not the full enum: it is private
 * and has already been renamed once (`CASCADE_RUN_STATUS_*`).
 */
const RUNNING_STATUS = /RUNNING|BUSY|ACTIVE|PENDING|WAITING/i
const ERROR_STATUS = /ERROR|FAIL/i

async function scanThreads() {
  const now = Date.now()
  const threads = []
  const seen = new Set()

  for (const home of HOMES) {
    const [entries, where, index] = await Promise.all([
      scanTranscripts(home.dir),
      workspaces(home.dir),
      summaries(home.dir),
    ])
    for (const entry of entries) {
      // The same conversation in both homes would be one bot drawn twice; the first home wins.
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      const summary = index.get(entry.id)
      // A sub-agent's own conversation is an errand of its parent, not a thread of its own.
      if (summary?.child) continue
      const blocked = RUNNING_STATUS.test(summary?.status || '') && (await awaitingApproval(home.dir, entry.id))
      threads.push(await threadOf(entry, home, where, summary, now, blocked))
    }
  }
  return threads
}

async function threadOf(entry, home, where, summary, now, blocked = false) {
  const f = await facts(entry)
  const cwd = f.cwd || where.get(entry.id) || summary?.cwd || ''
  const projectPath = cwd
  const project = cwd ? path.basename(cwd) : 'unknown'
  const prompt = f.prompt
  const title = summary?.title || prompt || 'Untitled thread'
  const lastActivityAt = Math.max(entry.mtime, summary?.updatedAt || 0)
  const fresh = now - lastActivityAt < ACTIVE_WINDOW_MS
  // Blocked on an approval is not working, however the index labels it, and it wants you.
  const running = blocked
    ? false
    : summary?.status
      ? RUNNING_STATUS.test(summary.status) && !summary.killed && fresh
      : !f.closed && fresh

  return {
    id: ID(entry.id),
    title: title.slice(0, 120),
    preview: prompt.slice(0, 240),
    project,
    projectPath,
    worktree: '',
    cwd,
    gitBranch: '',
    model: 'antigravity',
    effort: '',
    createdAt: f.startedAt || entry.born || entry.mtime,
    lastActivityAt,
    lastFocusedAt: 0,
    unread: blocked,
    running,
    hasError: f.errored || ERROR_STATUS.test(summary?.status || ''),
    starred: false,
    routine: '',
    prState: '',
    archived: false,
    sizeBytes: entry.size,
    source: home.source,
    canOpen: true,
    ref: { sessionId: entry.id, cwd },
  }
}

async function openThread(ref) {
  const id = ref?.sessionId
  if (typeof id !== 'string' || !UUID.test(id)) {
    return { ok: false, error: 'No openable Antigravity session id on that thread' }
  }
  const cwd = typeof ref?.cwd === 'string' ? ref.cwd : ''
  const bin = (await findExecutable('antigravity')) || (await findExecutable('antigravity-cli'))
  const url = `antigravity://resume?session=${id}`
  let command
  if (bin) {
    command = { argv: [bin, '--resume', id], cwd }
  }
  return { ok: true, url, command }
}

async function newSession(dir) {
  const abs = String(dir || '').replace(/\\/g, '/')
  if (!abs.startsWith('/')) return { ok: false, error: 'That folder is not somewhere Antigravity can open' }
  const bin = (await findExecutable('antigravity')) || (await findExecutable('antigravity-cli'))
  const url = `antigravity://new?${new URLSearchParams({ path: abs })}`
  let command
  if (bin) {
    command = { argv: [bin], cwd: abs }
  }
  return { ok: true, url, command }
}

async function detect() {
  for (const home of HOMES) if (await exists(path.join(home.dir, 'brain'))) return true
  return false
}

async function diagnostic() {
  const app = HOMES.find((h) => h.source === 'desktop')
  if (app && (await exists(path.join(app.dir, 'conversation_summaries.db'))) && !(await sqliteApi())?.DatabaseSync) {
    return 'Antigravity app sessions need node:sqlite (Node 22.13+) for their titles and folders'
  }
  return ''
}

export default {
  // The id stays `antigravity` and the thread ids stay `antigravity:<uuid>`: colony.json keys on
  // both, and a CLI user's saved layout must not move because the app is now read too.
  id: 'antigravity',
  name: 'Antigravity',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: { ANTIGRAVITY_HOME, BRAIN_DIR, HOMES: HOMES.map((h) => h.dir) },
}
