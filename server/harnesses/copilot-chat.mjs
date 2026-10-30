/**
 * Harness adapter: GitHub Copilot Chat, the chat panel built into VS Code itself.
 *
 * Every extension gets its own private folder per workspace, and Copilot Chat writes an
 * event-sourced transcript there for every chat session:
 *   <VS Code user data dir>/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<id>.jsonl
 * One JSON object per line — `session.start`, `user.message`, `assistant.message`,
 * `assistant.turn_start`/`turn_end`, `tool.execution_start`/`execution_complete` — the closest
 * thing this harness has to Claude Code's CLI `.jsonl`, and, like that one, always there
 * regardless of any opt-in setting. This adapter reads nothing else to decide whether a thread
 * exists.
 *
 * Two things the transcript itself does not know, and where the rest comes from:
 *
 * - **Which project it belongs to.** The `<hash>` is a one-way hash of the workspace's own URI,
 *   not a folder name to reverse. VS Code's own answer lives right next to the transcripts, in
 *   `workspaceStorage/<hash>/workspace.json` — `{"folder": "<uri>"}` for a single folder,
 *   `{"workspace": "<uri-to-.code-workspace>"}` for a multi-root one. That URI can be `file://`
 *   or, over Remote-SSH/WSL/a dev container, `vscode-remote://<authority>/<path>` — the
 *   authority names the connection, not a place, so only the path after it is read. On at least
 *   one remote setup this file never appears on the *remote* host at all (it is workbench state,
 *   and the workbench runs on the client machine) — this adapter falls back to whatever
 *   `session-store.db` below can offer rather than guessing a path from the hash.
 * - **What branch it is on.** Nothing in the transcript says. `session-store.db` sometimes does.
 *
 * `session-store.db` is `globalStorage/github.copilot-chat/session-store.db`, a SQLite database
 * behind the local session index (off by default) that the `chronicle` chat skill also queries.
 * It is used here only to fill in `cwd`/`branch` for the exact session ids this scan already
 * found on disk — never as the thing that decides a session exists: it is not present on every
 * install, and even where it is, its indexing lags the transcript itself (a session started
 * minutes earlier was still missing from it in testing). `node:sqlite` is imported lazily,
 * exactly as `opencode.mjs` does, so its absence on an older Node costs nothing but the
 * enrichment.
 *
 * No title is ever persisted anywhere for a session, and — measured against 37 real transcripts
 * on one machine — the opening prompt of a session is itself usually not logged as a
 * `user.message` at all; only the follow-ups are (35 of 37 open directly on `assistant.message`,
 * one opens on a slash command logged as `user.message`, one is a still-empty session). So a
 * thread's title falls back to the first assistant message's own `reasoningText` — the model's
 * paraphrase of the ask rather than the ask itself, which is the honest option once the literal
 * prompt has proved unavailable most of the time.
 *
 * There is no known deep link or CLI flag that opens one specific chat session — only a folder.
 * `openThread` says so rather than pretending a folder is the thread.
 *
 * Read-only, without exception, and no subprocess anywhere. Nothing here writes to a transcript,
 * a workspace.json, or session-store.db.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, findExecutable, jsonLines, listDirs, listFiles, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()

const HEAD_BYTES = 128 * 1024
const TAIL_BYTES = 32 * 1024

/**
 * How recently a transcript must have moved to count as "active now". There is no live-process
 * registry to check the way Claude Code and Codex have one — the extension host is a single
 * process shared by every window and every session, so its mere existence says nothing about
 * which session, if any, currently has the turn.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `copilot-chat:${raw}`

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/**
 * Every `<user dir>` this adapter looks under. `BOT_CROSSING_COPILOT_CHAT_ROOT` overrides the
 * whole list with one directory, the way `BOT_CROSSING_CURSOR_PROJECTS` does for Cursor — it is
 * how a test fakes an install without touching a real one.
 *
 * Stable and Insiders both count, since a machine can have either or both. Remote-SSH, WSL and
 * dev containers all land the extension host's own storage under `~/.vscode-server`, no matter
 * what client connects to it — that is the side this adapter has to read, since it runs on the
 * same machine as the harness it is scanning.
 */
function candidateRoots() {
  const override = process.env.BOT_CROSSING_COPILOT_CHAT_ROOT
  if (typeof override === 'string' && override) return [override]

  const roots = []
  switch (process.platform) {
    case 'win32': {
      const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')
      roots.push(path.join(roaming, 'Code', 'User'), path.join(roaming, 'Code - Insiders', 'User'))
      break
    }
    case 'darwin': {
      const support = path.join(HOME, 'Library', 'Application Support')
      roots.push(path.join(support, 'Code', 'User'), path.join(support, 'Code - Insiders', 'User'))
      break
    }
    default: {
      const config = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')
      roots.push(path.join(config, 'Code', 'User'), path.join(config, 'Code - Insiders', 'User'))
    }
  }
  roots.push(path.join(HOME, '.vscode-server', 'data', 'User'))
  roots.push(path.join(HOME, '.vscode-server-insiders', 'data', 'User'))
  return roots
}

/** `file:///a/b`, `vscode-remote://wsl%2Bubuntu/a/b` and `file:///C:/a/b` all resolve to a path. */
function decodeWorkspaceUri(uri) {
  let parsed
  try {
    parsed = new URL(uri)
  } catch {
    return ''
  }
  let p
  try {
    p = decodeURIComponent(parsed.pathname)
  } catch {
    p = parsed.pathname
  }
  // The URI form of a Windows path has a leading slash before the drive letter that the path
  // itself does not: `/C:/Users/x`, not `C:/Users/x`.
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p
}

/**
 * VS Code's own record of which folder a `workspaceStorage/<hash>` belongs to — read fresh each
 * call rather than cached, since it is one small file and this adapter is not the one paying to
 * parse a multi-megabyte transcript.
 */
async function readWorkspaceJson(hashDir) {
  let raw
  try {
    raw = JSON.parse(await fsp.readFile(path.join(hashDir, 'workspace.json'), 'utf8'))
  } catch {
    return null
  }
  const isWorkspaceFile = typeof raw?.workspace === 'string' && raw.workspace
  const uri = isWorkspaceFile ? raw.workspace : raw?.folder
  if (typeof uri !== 'string' || !uri) return null
  const decoded = decodeWorkspaceUri(uri)
  if (!decoded) return null
  // A `.code-workspace` file names the manifest, not the folder — the project is the directory
  // holding it.
  const projectPath = isWorkspaceFile ? path.dirname(decoded) : decoded
  return { projectPath, project: path.basename(projectPath) || projectPath }
}

/** What the head of a transcript knows about itself: when it started, and what to call it. */
function parseHead(records) {
  const meta = { startedAt: 0, prompt: '', fallbackPrompt: '' }
  for (const r of records) {
    if (!meta.startedAt && r.type === 'session.start') {
      const t = Date.parse(r.data?.startTime || '')
      if (!Number.isNaN(t)) meta.startedAt = t
    }
    // The real ask, when the harness happens to have logged it (a slash command, or any message
    // past the first).
    if (!meta.prompt && r.type === 'user.message') {
      const text = clean(r.data?.content)
      if (text) meta.prompt = text
    }
    // The model's own paraphrase of the opening ask — see the file header for why this is the
    // fallback rather than the first choice.
    if (!meta.fallbackPrompt && r.type === 'assistant.message') {
      const text = clean(r.data?.reasoningText)
      if (text) meta.fallbackPrompt = text
    }
  }
  return meta
}

/** Transcript metadata is expensive to parse, so keep it until the file changes. */
const metaCache = new Map()
async function transcriptMeta(id, file, mtime) {
  const cached = metaCache.get(id)
  if (cached && cached.mtime === mtime) return cached.meta
  let meta
  try {
    meta = parseHead(jsonLines(await readHead(file, HEAD_BYTES)))
  } catch {
    meta = parseHead([])
  }
  metaCache.set(id, { mtime, meta })
  return meta
}

/**
 * Whether a transcript's last event leaves the turn with the extension, not with you.
 *
 * There is no `stop_reason` or `turn_ended` marker to read the way Claude Code's or Cursor's
 * transcripts have — only the plain fact of which event type is last. A turn that has formally
 * closed (`assistant.turn_end`), or a session nobody has said anything in yet (`session.start`
 * alone), is idle either way; anything else — a turn just opened, a message mid-stream, a tool
 * still running — means the last word belongs to the assistant. Gated on recency because a
 * window closed mid-turn leaves the transcript in exactly that same shape forever after.
 */
async function isRunning(file, mtime) {
  if (Date.now() - mtime > ACTIVE_WINDOW_MS) return false
  let records
  try {
    records = jsonLines(await readTail(file, TAIL_BYTES))
  } catch {
    return false
  }
  if (!records.length) return false
  const last = records[records.length - 1].type
  return last !== 'assistant.turn_end' && last !== 'session.start'
}

/** `node:sqlite` needs Node 22.5+; its absence just means no enrichment, not a broken harness. */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/**
 * `cwd`/`branch` for exactly the session ids this scan already found, from the local session
 * index — undocumented, off by default, and never the thing that decides a session exists. Every
 * column is checked before it is named, the way `opencode.mjs` checks `session`'s, because this
 * store is a moving target this adapter does not own.
 */
async function sessionStoreLookup(root, ids) {
  const out = new Map()
  if (!ids.length) return out
  const file = path.join(root, 'globalStorage', 'github.copilot-chat', 'session-store.db')
  if (!(await exists(file))) return out
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) return out

  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    const tables = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name)
    )
    if (!tables.has('sessions')) return out
    const cols = new Set(db.prepare(`PRAGMA table_info(sessions)`).all().map((r) => r.name))
    if (!cols.has('id') || !cols.has('cwd')) return out
    const hasBranch = cols.has('branch')
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT id, cwd${hasBranch ? ', branch' : ''} FROM sessions WHERE id IN (${placeholders})`)
      .all(...ids)
    for (const r of rows) {
      if (typeof r.id !== 'string' || !r.id) continue
      out.set(r.id, {
        cwd: typeof r.cwd === 'string' ? r.cwd : '',
        branch: hasBranch && typeof r.branch === 'string' ? r.branch : '',
      })
    }
  } catch {
    /* an undocumented store, mid-write or the wrong shape — the transcript alone still works */
  } finally {
    try {
      db?.close()
    } catch {
      /* already gone */
    }
  }
  return out
}

async function scanThreads() {
  const groups = []
  for (const root of candidateRoots()) {
    for (const hashDir of await listDirs(path.join(root, 'workspaceStorage'))) {
      const transcriptsDir = path.join(hashDir, 'GitHub.copilot-chat', 'transcripts')
      const files = await listFiles(transcriptsDir, (n) => n.endsWith('.jsonl'))
      if (files.length) groups.push({ root, hashDir, files })
    }
  }
  if (!groups.length) return []

  // Stat every transcript up front: the database lookup below needs the id list, and the
  // per-thread pass after it needs the same stats again.
  const entries = []
  for (const { root, hashDir, files } of groups) {
    for (const file of files) {
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      if (!stat.size) continue
      entries.push({ root, hashDir, id: path.basename(file, '.jsonl'), file, stat })
    }
  }

  const dbInfo = new Map()
  for (const root of new Set(entries.map((e) => e.root))) {
    const ids = entries.filter((e) => e.root === root).map((e) => e.id)
    for (const [id, info] of await sessionStoreLookup(root, ids)) dbInfo.set(id, info)
  }

  const workspaceCache = new Map()
  const threads = []
  for (const entry of entries) {
    if (!workspaceCache.has(entry.hashDir)) {
      workspaceCache.set(entry.hashDir, await readWorkspaceJson(entry.hashDir))
    }
    const ws = workspaceCache.get(entry.hashDir)
    const db = dbInfo.get(entry.id)
    const projectPath = ws?.projectPath || db?.cwd || ''
    const project = ws?.project || (projectPath && path.basename(projectPath)) || 'unknown'

    const meta = await transcriptMeta(entry.id, entry.file, entry.stat.mtimeMs)
    const prompt = meta.prompt || meta.fallbackPrompt

    threads.push({
      id: ID(entry.id),
      title: (prompt || 'Untitled thread').slice(0, 120),
      preview: prompt.slice(0, 240),
      project,
      projectPath,
      // VS Code has no worktree concept of its own to report.
      worktree: '',
      cwd: projectPath,
      gitBranch: db?.branch || '',
      model: '',
      effort: '',
      createdAt: meta.startedAt || entry.stat.birthtimeMs || entry.stat.mtimeMs,
      lastActivityAt: entry.stat.mtimeMs,
      // No focus history anywhere in this harness's own records — unknowable, not false-as-in-no.
      lastFocusedAt: 0,
      unread: false,
      running: await isRunning(entry.file, entry.stat.mtimeMs),
      // A failed tool call is routine agentic back-and-forth, not a session error, and nothing
      // else in this transcript marks a turn itself as having failed — guessing from tool
      // failures alone would redden most working sessions.
      hasError: false,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: entry.stat.size,
      source: 'vscode',
      // No per-thread deep link exists — see `openThread` — so there is nothing "Open" could do.
      canOpen: false,
      ref: { sessionId: entry.id },
    })
  }
  return threads
}

async function detect() {
  for (const root of candidateRoots()) {
    for (const hashDir of await listDirs(path.join(root, 'workspaceStorage'))) {
      if (await exists(path.join(hashDir, 'GitHub.copilot-chat'))) return true
    }
  }
  return false
}

/**
 * VS Code registers `vscode://file/<path>` for opening a folder, but nothing found addresses one
 * specific chat session within it — no URI, no CLI flag. Saying so plainly is the contract in
 * `server/harnesses/README.md`: the UI shows this message and greys the button, rather than
 * opening the folder and hoping that reads as the thread.
 */
async function openThread(ref) {
  const id = ref?.sessionId
  if (typeof id !== 'string' || !id) return { ok: false, error: 'No openable session id on that thread' }
  return {
    ok: false,
    error: "VS Code has no link or command that opens one specific chat session — open the project and find it in the Chat view's history instead.",
  }
}

/** Where the standalone `code` CLI lives, for the terminal fallback alongside the deep link. */
const CLI_DIRS = ['/usr/local/bin', '/usr/bin', '/snap/bin']
const cliBinary = () => findExecutable('code', CLI_DIRS)

/**
 * `vscode://file/<path>` opens a folder the same way `cursor://file/<path>` does for Cursor —
 * both forks keep the same handler. Segments are percent-encoded individually so a Windows drive
 * letter's colon round-trips the way VS Code's own URI parsing expects.
 */
async function newSession(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    return { ok: false, error: 'That folder is not somewhere VS Code can open' }
  }
  const posix = dir.replace(/\\/g, '/')
  const withSlash = posix.startsWith('/') ? posix : `/${posix}`
  const url = `vscode://file${withSlash.split('/').map(encodeURIComponent).join('/')}`

  let command
  const bin = await cliBinary()
  if (bin) command = { argv: [bin, dir], cwd: dir }

  return { ok: true, url, command }
}

export default {
  id: 'copilot-chat',
  name: 'GitHub Copilot Chat',
  detect,
  scanThreads,
  openThread,
  newSession,
}
