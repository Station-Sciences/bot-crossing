/**
 * Harness adapter: Codex (OpenAI) — the desktop app and CLI share one local state database.
 *
 * Codex publishes its thread index in the newest ~/.codex/state_*.sqlite database. Metadata
 * comes from that database through Node's read-only SQLite mode; only the tail of a rollout is
 * read for live/error state, which the index does not currently expose. No scan runs a process
 * or reaches into an application bundle.
 */
import fsp from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { jsonLines, num } from '../lib/fsutil.mjs'

const execFileAsync = promisify(execFile)
const HOME = os.homedir()
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex')
const APP_STATE = path.join(CODEX_HOME, '.codex-global-state.json')
const CODEX_BINARY_ENV = 'BOT_CROSSING_CODEX_BIN'

const TAIL_BYTES = 512 * 1024
const MAX_ACTIVE_TAIL_BYTES = 2 * 1024 * 1024
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const STATE_DATABASE = /^state_(\d+)\.sqlite$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APP_BUNDLE_EXECUTABLE = /\.app[/\\]Contents[/\\]/i

let sqlitePromise
async function sqliteApi() {
  if (!sqlitePromise) sqlitePromise = import('node:sqlite').catch(() => null)
  return sqlitePromise
}

async function diagnostic() {
  if (!(await latestStateDatabase())) return ''
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 13) || !(await sqliteApi())?.DatabaseSync) {
    return 'Codex requires Node 22.13 or newer; restart Bot Crossing with a supported Node version'
  }
  return ''
}

let codexHomeRealPromise
async function safeCodexFile(file) {
  if (typeof file !== 'string' || !file) return ''
  if (!codexHomeRealPromise) {
    codexHomeRealPromise = fsp.realpath(CODEX_HOME).catch(() => path.resolve(CODEX_HOME))
  }
  try {
    const [home, real] = await Promise.all([codexHomeRealPromise, fsp.realpath(file)])
    const relative = path.relative(home, real)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      return ''
    }
    return real
  } catch {
    return ''
  }
}

/** Pick the highest schema version, not the most recently touched WAL sibling. */
async function latestStateDatabase() {
  let entries
  try {
    entries = await fsp.readdir(CODEX_HOME, { withFileTypes: true })
  } catch {
    return ''
  }
  return entries
    .filter((entry) => entry.isFile() && STATE_DATABASE.test(entry.name))
    .map((entry) => ({
      file: path.join(CODEX_HOME, entry.name),
      version: Number(entry.name.match(STATE_DATABASE)[1]),
    }))
    .sort((a, b) => b.version - a.version)[0]?.file || ''
}

const column = (columns, name, fallback = "''") =>
  columns.has(name) ? `t.${name}` : fallback

function timestampExpression(columns, milliseconds, seconds) {
  if (columns.has(milliseconds) && columns.has(seconds)) {
    return `COALESCE(t.${milliseconds}, t.${seconds} * 1000)`
  }
  if (columns.has(milliseconds)) return `t.${milliseconds}`
  if (columns.has(seconds)) return `t.${seconds} * 1000`
  return '0'
}

/** Read the canonical thread index. The connection itself refuses writes. */
async function databaseThreads() {
  const [databaseFile, sqlite] = await Promise.all([latestStateDatabase(), sqliteApi()])
  const error = await diagnostic()
  if (error) throw new Error(error)
  if (!databaseFile) return { rows: [], projectRoots: new Map() }

  const database = new sqlite.DatabaseSync(databaseFile, { readOnly: true })
  try {
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
    )
    if (!tables.has('threads')) return { rows: [], projectRoots: new Map() }

    const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map((row) => row.name))
    if (!['id', 'cwd', 'source'].every((name) => columns.has(name))) {
      throw new Error('Codex state database is missing required thread columns')
    }

    const children = new Set()
    if (tables.has('thread_spawn_edges')) {
      const edgeColumns = new Set(
        database.prepare('PRAGMA table_info(thread_spawn_edges)').all().map((row) => row.name)
      )
      if (edgeColumns.has('child_thread_id')) {
        for (const row of database.prepare('SELECT child_thread_id FROM thread_spawn_edges').all()) {
          if (typeof row.child_thread_id === 'string') children.add(row.child_thread_id)
        }
      }
    }

    const projectRoots = new Map()
    if (columns.has('project_id') && tables.has('project_roots')) {
      const rootColumns = new Set(
        database.prepare('PRAGMA table_info(project_roots)').all().map((row) => row.name)
      )
      if (['project_id', 'path', 'position'].every((name) => rootColumns.has(name))) {
        const roots = database
          .prepare('SELECT project_id, path FROM project_roots ORDER BY project_id, position')
          .all()
        for (const root of roots) {
          if (!projectRoots.has(root.project_id) && typeof root.path === 'string') {
            projectRoots.set(root.project_id, root.path)
          }
        }
      }
    }

    const createdAt = timestampExpression(columns, 'created_at_ms', 'created_at')
    const updatedAt = timestampExpression(columns, 'updated_at_ms', 'updated_at')
    const rows = database
      .prepare(`
        SELECT
          t.id,
          ${column(columns, 'name')} AS name,
          ${column(columns, 'title')} AS title,
          ${column(columns, 'preview')} AS preview,
          ${column(columns, 'first_user_message')} AS first_user_message,
          t.cwd,
          t.source,
          ${column(columns, 'thread_source')} AS thread_source,
          ${column(columns, 'git_branch')} AS git_branch,
          ${column(columns, 'git_origin_url')} AS git_origin_url,
          ${column(columns, 'model')} AS model,
          ${column(columns, 'reasoning_effort')} AS reasoning_effort,
          ${column(columns, 'rollout_path')} AS rollout_path,
          ${column(columns, 'project_id')} AS project_id,
          ${column(columns, 'archived', '0')} AS archived,
          ${column(columns, 'is_pinned', '0')} AS is_pinned,
          ${createdAt} AS created_at_ms,
          ${updatedAt} AS updated_at_ms
        FROM threads t
        WHERE t.source IN ('cli', 'vscode', 'exec')
      `)
      .all()
      .filter(
        (row) =>
          typeof row.id === 'string' && UUID.test(row.id) && typeof row.cwd === 'string' &&
          !children.has(row.id) &&
          !['subagent', 'guardian_review'].includes(row.thread_source)
      )

    return { rows, projectRoots }
  } finally {
    database.close()
  }
}

/** Drop UI context injected ahead of the prompt; it is not card copy a person authored. */
function cleanPrompt(value) {
  const text = String(value || '')
    .replace(/<(in-app-browser-context|environment_context)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const request = text.lastIndexOf('## My request:')
  return (request === -1 ? text : text.slice(request + '## My request:'.length))
    .replace(/\s+/g, ' ')
    .trim()
}

function shortTitle(value) {
  const title = cleanPrompt(value)
  if (title.length <= 120) return title
  const cut = title.slice(0, 117)
  const boundary = cut.lastIndexOf(' ')
  return (boundary > 72 ? cut.slice(0, boundary) : cut).trimEnd() + '…'
}

/** Older desktop threads have project assignments here rather than in the database. */
async function desktopState() {
  try {
    const state = JSON.parse(await fsp.readFile(APP_STATE, 'utf8'))
    const ids = state?.['electron-persisted-atom-state']?.['unread-thread-ids-by-host-v1']?.local
    const roots = new Map()
    for (const [id, root] of Object.entries(state?.['thread-workspace-root-hints'] || {})) {
      if (typeof root === 'string' && path.isAbsolute(root)) roots.set(id, root)
    }
    for (const [id, assignment] of Object.entries(state?.['thread-project-assignments'] || {})) {
      const root = state?.['local-projects']?.[assignment?.projectId]?.rootPaths?.[0]
      if (!roots.has(id) && typeof root === 'string' && path.isAbsolute(root)) roots.set(id, root)
    }
    return { unread: new Set(Array.isArray(ids) ? ids.filter((id) => UUID.test(id)) : []), roots }
  } catch {
    return { unread: new Set(), roots: new Map() }
  }
}

async function readTail(handle, size, bytes) {
  const length = Math.min(size, bytes)
  const start = Math.max(0, size - length)
  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await handle.read(buffer, 0, length, start)
  let text = buffer.subarray(0, bytesRead).toString('utf8')
  if (start) text = text.slice(text.indexOf('\n') + 1)
  if (!text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1)
  return text
}

function readLifecycle(records) {
  let lifecycle = null
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const payload = record?.payload || {}
    if (
      record.type === 'event_msg' &&
      ['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)
    ) {
      lifecycle = { type: payload.type, error: Boolean(payload.error) }
    }
  }
  return lifecycle
}

/** Small boundary check distinguishes append-only growth from a rewritten transcript. */
async function boundary(handle, size) {
  const buffer = Buffer.alloc(Math.min(size, 128))
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length)
  return buffer.subarray(0, bytesRead).toString('base64')
}

/** Rollout tails supply only ephemeral state not represented in the SQLite index. */
const lifecycleCache = new Map()
async function rolloutLifecycle(file) {
  const safeFile = await safeCodexFile(file)
  const empty = { lifecycle: null, size: 0, mtime: 0 }
  if (!safeFile) {
    lifecycleCache.delete(file)
    return empty
  }
  let handle
  try {
    handle = await fsp.open(safeFile, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) {
      lifecycleCache.delete(file)
      return empty
    }
    const cached = lifecycleCache.get(file)
    const sameFile = cached && cached.ino === stat.ino && cached.dev === stat.dev &&
      cached.birthtime === stat.birthtimeMs
    if (sameFile && cached.mtime === stat.mtimeMs && cached.ctime === stat.ctimeMs &&
        cached.size === stat.size) return cached

    const appended = sameFile && stat.size > cached.size &&
      await boundary(handle, cached.size) === cached.boundary
    let lifecycle = readLifecycle(jsonLines(await readTail(handle, stat.size, TAIL_BYTES)))
    if (!lifecycle && !(appended && cached.lifecycle) && Date.now() - stat.mtimeMs < ACTIVE_WINDOW_MS) {
      lifecycle = readLifecycle(jsonLines(await readTail(handle, stat.size, MAX_ACTIVE_TAIL_BYTES)))
    }
    if (!lifecycle && appended) lifecycle = cached.lifecycle
    const result = {
      mtime: stat.mtimeMs, ctime: stat.ctimeMs, size: stat.size,
      ino: stat.ino, dev: stat.dev, birthtime: stat.birthtimeMs,
      boundary: await boundary(handle, stat.size), lifecycle,
    }
    lifecycleCache.set(file, result)
    return result
  } catch {
    // One disappearing, unreadable, or mid-replacement rollout must not hide the other tasks.
    lifecycleCache.delete(file)
    return empty
  } finally {
    await handle?.close()
  }
}

/** Use Codex's project index when available. Older rows safely fall back to their cwd. */
function projectOf(row, projectRoots, desktopRoots) {
  const indexedRoot = projectRoots.get(row.project_id) || desktopRoots.get(row.id) || ''
  const projectPath = indexedRoot || row.cwd || ''
  const relative = path.relative(path.join(CODEX_HOME, 'worktrees'), row.cwd || '')
  const isCodexWorktree = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
  const worktree = isCodexWorktree ? relative.split(path.sep)[0] :
    indexedRoot && indexedRoot !== row.cwd ? path.basename(row.cwd) : ''
  return { projectPath, project: path.basename(projectPath) || projectPath || 'unknown', worktree }
}

async function scanThreads() {
  const [{ rows, projectRoots }, desktop] = await Promise.all([databaseThreads(), desktopState()])
  const rollouts = new Set(rows.map((row) => row.rollout_path))
  for (const file of lifecycleCache.keys()) if (!rollouts.has(file)) lifecycleCache.delete(file)
  return await Promise.all(
    rows.map(async (row) => {
      const rollout = await rolloutLifecycle(row.rollout_path)
      const { lifecycle } = rollout
      const firstPrompt = cleanPrompt(row.preview || row.first_user_message)
      const title = shortTitle(row.name || row.title || firstPrompt) || 'Untitled thread'
      const { projectPath, project, worktree } = projectOf(row, projectRoots, desktop.roots)
      const lastActivityAt = Math.max(num(row.updated_at_ms), rollout.mtime)
      return {
        id: row.id,
        title,
        preview: firstPrompt.slice(0, 240),
        project,
        projectPath,
        worktree,
        cwd: row.cwd || '',
        gitBranch: row.git_branch || '',
        model: row.model || '',
        effort: row.reasoning_effort || '',
        createdAt: num(row.created_at_ms) || lastActivityAt,
        lastActivityAt,
        lastFocusedAt: 0,
        // ponytail: transcript activity is a heuristic; use a live event stream if exact state is needed.
        running: !row.archived && lifecycle?.type === 'task_started' &&
          Date.now() - rollout.mtime < ACTIVE_WINDOW_MS,
        activityNote: 'Codex activity is inferred from recent transcript events (30-minute ceiling)',
        unread: desktop.unread.has(row.id),
        hasError: lifecycle?.type === 'task_complete' && lifecycle.error,
        starred: Boolean(row.is_pinned),
        routine: '',
        prState: '',
        archived: Boolean(row.archived),
        sizeBytes: rollout.size,
        source: row.source,
        canOpen: true,
        canArchive: true,
        ref: { sessionId: row.id },
      }
    })
  )
}

function openThread(ref) {
  const id = ref?.sessionId || ''
  if (!UUID.test(id)) return { ok: false, error: 'No openable Codex session id on that thread' }
  return { ok: true, url: 'codex://threads/' + id }
}

function newSession(dir) {
  return { ok: true, url: 'codex://threads/new?' + new URLSearchParams({ path: dir }) }
}

/** Resolve only an explicit override or PATH entry, and only after Archive is clicked. */
async function codexBinary() {
  const override = process.env[CODEX_BINARY_ENV]
  const candidates = []
  if (override) candidates.push(path.isAbsolute(override) ? override : path.resolve(override))
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, 'codex'))
  }
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fsConstants.X_OK)
      const real = await fsp.realpath(candidate)
      // PATH can itself contain an app's Resources directory, and a harmless-looking symlink
      // can resolve back into one. Never execute either form from another app's bundle.
      if (APP_BUNDLE_EXECUTABLE.test(real)) continue
      return real
    } catch {
      /* try the next PATH entry */
    }
  }
  return ''
}

async function setArchived(ref, archived) {
  const id = ref?.sessionId || ''
  if (!UUID.test(id)) return { ok: false, error: 'No archivable Codex session id on that thread' }
  if (typeof archived !== 'boolean') return { ok: false, error: 'Archive state must be a boolean' }
  const binary = await codexBinary()
  if (!binary) {
    return {
      ok: false,
      error: `No standalone Codex CLI found; install it or set ${CODEX_BINARY_ENV}`,
    }
  }
  try {
    await execFileAsync(binary, [archived ? 'archive' : 'unarchive', id], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
    return { ok: true, archived: Boolean(archived) }
  } catch (error) {
    const detail = String(error?.stderr || error?.message || '').trim().split('\n').pop()
    return { ok: false, error: detail || 'Codex could not update that session' }
  }
}

async function detect() {
  return Boolean(await latestStateDatabase())
}

export default {
  id: 'codex',
  name: 'Codex',
  detect,
  diagnostic,
  archiveSync: 'database',
  scanThreads,
  openThread,
  newSession,
  setArchived,
  paths: { CODEX_HOME, APP_STATE },
}
