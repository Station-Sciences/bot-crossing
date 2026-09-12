/**
 * Harness adapter: Cursor (Anysphere) — sidebar metadata plus agent transcripts.
 *
 * Cursor's global `state.vscdb` can be multi-gigabyte and is held open read-write by the editor.
 * This adapter still reads it because it is the only source for sidebar/composer titles, workspaces
 * and status, but it mitigates that cost in three deliberate ways: the SQL projects NULL instead of
 * every large subagent blob, an mtime+size cache avoids re-querying an unchanged database on the
 * fifteen-second poll, and a last-good snapshot survives a transient lock.
 *
 * The database is merged with
 * `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`. Sidebar metadata wins
 * for title and state; transcripts win for byte size and error state. Task/subagent children are
 * omitted. If SQLite is unavailable or the private schema cannot be read, transcript-only rows
 * remain visible and `diagnostic()` explains the degraded mode.
 *
 * Thread focus has no native Cursor deep link. On Open only, a helper extension is installed via a
 * `cursor` CLI found on PATH or under `~/.cursor/bin`; no application bundle is inspected or
 * executed. The extension consumes a short-lived request under `~/.cursor/`. See DIVERGENCE.md.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { exists, findExecutable, jsonLines, listDirs, listFiles, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const PROJECTS = process.env.BOT_CROSSING_CURSOR_PROJECTS || path.join(HOME, '.cursor', 'projects')
const TRANSCRIPTS = 'agent-transcripts'
const OPEN_REQUEST = process.env.BOT_CROSSING_CURSOR_OPEN_REQUEST || path.join(HOME, '.cursor', 'bot-crossing-open.json')
const EXTENSION_DIR = fileURLToPath(new URL('../../tools/cursor-open-extension/', import.meta.url))

const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 32 * 1024
/** Cursor writes nothing when it is killed, so an unclosed turn needs a time bound as well. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `cursor:${raw}`

function userDataDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Cursor')
    case 'linux':
      return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Cursor')
    default:
      return path.join(HOME, 'Library', 'Application Support', 'Cursor')
  }
}

const STATE_DB =
  process.env.BOT_CROSSING_CURSOR_STATE_DB ||
  path.join(userDataDir(), 'User', 'globalStorage', 'state.vscdb')

/** Lazy for the same reason as Codex: old Node degrades one metadata source, not the server. */
let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

const WORKTREE = /[\\/](?:\.cursor[\\/]worktrees|\.wt)[\\/]([^\\/]+)/
function splitWorktree(cwd) {
  const m = WORKTREE.exec(cwd || '')
  if (!m) return { root: cwd || '', worktree: '' }
  return { root: cwd.slice(0, m.index), worktree: m[1] }
}

function workspacePathOf(header) {
  const uri = header?.workspaceIdentifier?.uri
  const value = uri?.fsPath || uri?.path || ''
  return typeof value === 'string' && path.isAbsolute(value) ? value : ''
}

function activeRepoOf(header) {
  let best = null
  for (const repo of Array.isArray(header?.trackedGitRepos) ? header.trackedGitRepos : []) {
    if (typeof repo?.repoPath !== 'string' || !path.isAbsolute(repo.repoPath)) continue
    const branch = (Array.isArray(repo.branches) ? repo.branches : []).reduce(
      (a, b) => (!a || Number(b?.lastInteractionAt) > Number(a?.lastInteractionAt) ? b : a),
      null,
    )
    const at = Number(branch?.lastInteractionAt) || 0
    if (!best || at > best.at) best = { path: repo.repoPath, branch: branch?.branchName || '', at }
  }
  return best
}

const dbColumn = (columns, name, fallback = 'NULL') =>
  columns.has(name) ? `"${name}"` : `${fallback} AS "${name}"`

let databaseProblem = ''
let headerCache = null
let lastGoodHeaders = { rows: new Map(), subagents: new Set() }

/**
 * Read the private table defensively. Every named column is probed first because Cursor changes
 * this schema without notice; a missing optional field should not cost the transcript half.
 */
async function databaseRows() {
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) {
    databaseProblem = `Cursor sidebar metadata needs Node 22.13 or newer (running ${process.versions.node})`
    return lastGoodHeaders
  }

  let stat
  try {
    stat = await fsp.stat(STATE_DB)
    if (!stat.isFile()) throw new Error('not a file')
  } catch {
    if (await exists(STATE_DB)) {
      databaseProblem = 'Cursor sidebar metadata is unavailable because state.vscdb is unreadable'
    }
    return lastGoodHeaders
  }
  // Date/utimes and some network filesystems expose different sub-millisecond precision for the
  // same timestamp; whole milliseconds are the stable cache key Node offers across platforms.
  const mtime = Math.trunc(stat.mtimeMs)
  if (headerCache?.mtime === mtime && headerCache?.size === stat.size) {
    return headerCache.value
  }

  let db
  try {
    db = new sqlite.DatabaseSync(STATE_DB, { readOnly: true })
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    )
    if (!tables.has('composerHeaders')) throw new Error('composerHeaders table is missing')
    const columns = new Set(db.prepare('PRAGMA table_info(composerHeaders)').all().map((row) => row.name))
    if (!columns.has('composerId')) throw new Error('composerId column is missing')

    const valueExpr = columns.has('value')
      ? columns.has('isSubagent')
        ? 'CASE WHEN "isSubagent" THEN NULL ELSE "value" END AS "value"'
        : '"value"'
      : 'NULL AS "value"'
    const rows = db
      .prepare(`
        SELECT
          "composerId",
          ${dbColumn(columns, 'isSubagent', '0')},
          ${dbColumn(columns, 'createdAt', '0')},
          ${dbColumn(columns, 'lastUpdatedAt', '0')},
          ${dbColumn(columns, 'isArchived', '0')},
          ${dbColumn(columns, 'recency', '0')},
          ${valueExpr}
        FROM composerHeaders
      `)
      .all()

    const value = { rows: new Map(), subagents: new Set() }
    for (const row of rows) {
      const id = row.composerId
      if (typeof id !== 'string' || !UUID.test(id)) continue
      let embeddedSubagent = false
      if (row.value) {
        try {
          const header = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
          embeddedSubagent = header?.isSubagent === true
        } catch {
          /* malformed private metadata */
        }
      }
      if (row.isSubagent === 1 || row.isSubagent === true || embeddedSubagent) {
        value.subagents.add(id)
        continue
      }
      const parsed = parseHeaderRow(row)
      if (parsed) value.rows.set(id, parsed)
    }
    databaseProblem = ''
    lastGoodHeaders = value
    headerCache = { mtime, size: stat.size, value }
    return value
  } catch {
    databaseProblem =
      'Cursor sidebar metadata is temporarily unavailable because state.vscdb could not be read; showing transcript data'
    return lastGoodHeaders
  } finally {
    try {
      db?.close()
    } catch {
      /* failed open */
    }
  }
}

function parseHeaderRow(row) {
  let header = {}
  try {
    header = typeof row.value === 'string' ? JSON.parse(row.value) : row.value || {}
  } catch {
    header = {}
  }
  if (!header || typeof header !== 'object' || header.isDraft === true || header.isSubagent === true) return null
  const composerId = row.composerId || header.composerId || ''
  if (typeof composerId !== 'string' || !UUID.test(composerId)) return null

  const createdAt = Number(header.createdAt || row.createdAt) || 0
  const lastActivityAt = Math.max(
    Number(header.lastUpdatedAt) || 0,
    Number(header.conversationCheckpointLastUpdatedAt) || 0,
    Number(row.lastUpdatedAt) || 0,
    Number(row.recency) || 0,
    createdAt,
  )
  const workspace = workspacePathOf(header)
  const activeRepo = activeRepoOf(header)
  const location = activeRepo?.path || workspace
  const { root, worktree } = splitWorktree(location)
  const projectPath = root || location

  return {
    composerId,
    title: header.name || header.subtitle || '',
    preview: header.subtitle || '',
    project: path.basename(projectPath) || projectPath || 'unknown',
    projectPath,
    worktree,
    cwd: workspace || location,
    gitBranch: activeRepo?.branch || '',
    model: header.unifiedMode || header.forceMode || '',
    createdAt,
    lastActivityAt,
    lastFocusedAt: 0,
    unread: header.hasUnreadMessages === true || header.hasBlockingPendingActions === true,
    running: Boolean(Number(header.unfinishedRunAt)) && Date.now() - lastActivityAt < ACTIVE_WINDOW_MS,
    archived: row.isArchived === 1 || row.isArchived === true || header.isArchived === true,
  }
}

const isDir = async (p) => {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Turn `Users-jarren-Documents-GitHub-emra-app-builder` back into a path.
 *
 * Every separator became a dash and so did every dash already in a folder name, which makes the
 * encoding lossy and the obvious reverse — replace each dash with a slash — wrong for most real
 * repositories. On this machine it was wrong for *every* project with a transcript:
 * `emra-app-builder` came back as `emra/app/builder`, `personal-site-2025` as
 * `personal/site/2025`. Since `project` is what claims a hex zone, that is not cosmetic.
 *
 * So the disk decides. Walk the tokens and, at each step, take the longest run of them that
 * names a directory that actually exists, backtracking when a greedy match leads nowhere. A
 * repository that has since been deleted cannot be resolved by anyone, and falls back to
 * attaching the rest as a single dashed name — the likelier reading, since a folder name with
 * dashes in it is far more common than four nested single-word folders.
 */
async function resolvePath(tokens, from = '') {
  if (!tokens.length) return from
  for (let take = tokens.length; take >= 1; take--) {
    const candidate = `${from}/${tokens.slice(0, take).join('-')}`
    if (!(await isDir(candidate))) continue
    const rest = await resolvePath(tokens.slice(take), candidate)
    if (rest) return rest
  }
  return ''
}

const decodeCache = new Map()
async function decodeProjectDir(name) {
  if (decodeCache.has(name)) return decodeCache.get(name)
  const tokens = name.split('-').filter(Boolean)
  const resolved = await resolvePath(tokens)
  // Nothing on disk answers to it any more: keep the deepest ancestor that does and let the
  // remainder stand as one name.
  let out = resolved
  if (!out) {
    let dir = ''
    let i = 0
    while (i < tokens.length && (await isDir(`${dir}/${tokens[i]}`))) dir = `${dir}/${tokens[i++]}`
    out = i < tokens.length ? `${dir}/${tokens.slice(i).join('-')}` : dir
  }
  decodeCache.set(name, out)
  return out
}

/**
 * Cursor wraps a prompt in tags of its own — a timestamp, a note about attached images, the
 * query itself. Only the query is something a person typed, and it is the only part worth
 * putting on a card.
 */
function userText(record) {
  const parts = record?.message?.content
  const raw = Array.isArray(parts)
    ? parts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
    : String(parts || '')
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(raw)
  const text = query ? query[1] : raw.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/gi, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

/** `Tuesday, Sep 8, 2026, 4:08 PM (UTC-7)` if the first turn carried one. */
function stamp(record) {
  const parts = record?.message?.content
  const raw = Array.isArray(parts) ? parts.map((p) => p?.text || '').join('\n') : ''
  const m = /<timestamp>(.*?)<\/timestamp>/.exec(raw)
  const t = m ? Date.parse(m[1].replace(/\s*\(UTC[^)]*\)\s*$/, '')) : NaN
  return Number.isNaN(t) ? 0 : t
}

/** Every transcript on disk, with the project directory it sits under. */
async function scanTranscripts() {
  const out = []
  for (const projectDir of await listDirs(PROJECTS)) {
    const root = path.join(projectDir, TRANSCRIPTS)
    for (const sessionDir of await listDirs(root)) {
      const id = path.basename(sessionDir)
      if (!UUID.test(id)) continue
      for (const file of await listFiles(sessionDir, (n) => n.endsWith('.jsonl'))) {
        try {
          const st = await fsp.stat(file)
          if (!st.size) continue
          out.push({ id, file, dirName: path.basename(projectDir), size: st.size, mtime: st.mtimeMs, born: st.birthtimeMs })
        } catch {
          /* vanished between listing and stat */
        }
      }
    }
  }
  return out
}

/** Parsing is kept against mtime and size, so an unchanged transcript is read once. */
const cache = new Map()
async function facts(entry) {
  const hit = cache.get(entry.id)
  if (hit && hit.mtime === entry.mtime && hit.size === entry.size) return hit.value
  const value = { prompt: '', startedAt: 0, closed: true, modern: false, errored: false }
  try {
    for (const r of jsonLines(await readHead(entry.file, HEAD_BYTES))) {
      if (r?.role !== 'user') continue
      value.prompt = userText(r)
      value.startedAt = stamp(r)
      break
    }
    const tail = jsonLines(await readTail(entry.file, TAIL_BYTES))
    // `turn_ended` is a recent addition: transcripts written before it exist in numbers and
    // carry none at all. Treating "no marker" as "mid-turn" would light up every old thread on
    // the map, so a file only gets read that way once it has proved it writes them.
    const ended = tail.filter((r) => r?.type === 'turn_ended')
    value.modern = ended.length > 0
    const last = tail[tail.length - 1]
    value.closed = last?.type === 'turn_ended'
    value.errored = ended.length > 0 && ended[ended.length - 1].status !== 'success'
  } catch {
    /* mid-write, or gone */
  }
  cache.set(entry.id, { mtime: entry.mtime, size: entry.size, value })
  return value
}

async function scanThreads() {
  const entries = await scanTranscripts()
  const headers = await databaseRows()
  const now = Date.now()
  const byId = new Map(headers.rows)

  for (const entry of entries) {
    if (headers.subagents.has(entry.id)) continue
    const f = await facts(entry)
    const projectPath = await decodeProjectDir(entry.dirName)
    const prompt = f.prompt
    const transcript = {
      composerId: entry.id,
      title: (prompt || 'Untitled thread').slice(0, 120),
      preview: prompt.slice(0, 240),
      project: path.basename(projectPath) || 'unknown',
      projectPath,
      // Cursor records no worktree, and inferring one from the path would put a branch name on
      // a thread that never had one.
      worktree: '',
      cwd: projectPath,
      gitBranch: '',
      model: '',
      effort: '',
      createdAt: f.startedAt || entry.born || entry.mtime,
      lastActivityAt: entry.mtime,
      // No focus history, so "have you read this" is unknowable rather than false.
      lastFocusedAt: 0,
      unread: false,
      running: f.modern && !f.closed && now - entry.mtime < ACTIVE_WINDOW_MS,
      hasError: f.errored,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: entry.size,
      source: 'agent',
    }
    const composer = byId.get(entry.id)
    byId.set(
      entry.id,
      composer
        ? {
            ...transcript,
            ...composer,
            title: composer.title || transcript.title,
            preview: composer.preview || transcript.preview,
            sizeBytes: transcript.sizeBytes,
            hasError: transcript.hasError,
            source: 'composer+agent',
          }
        : transcript,
    )
  }

  return [...byId.values()].map((thread) => ({
    ...thread,
    id: ID(thread.composerId),
    title: (thread.title || 'Untitled thread').slice(0, 120),
    preview: (thread.preview || '').slice(0, 240),
    effort: '',
    starred: false,
    routine: '',
    prState: '',
    hasError: Boolean(thread.hasError),
    sizeBytes: thread.sizeBytes || 0,
    source: thread.source || 'composer',
    canOpen: typeof thread.composerId === 'string' && UUID.test(thread.composerId),
    ref: {
      composerId: thread.composerId,
      workspacePath: thread.cwd || thread.projectPath || '',
      projectPath: thread.projectPath || '',
    },
  }))
}

const execFileAsync = promisify(execFile)
let cursorBinPromise
const findCursorBin = () =>
  (cursorBinPromise ??= findExecutable(process.env.BOT_CROSSING_CURSOR_CLI || 'cursor', [
    path.join(HOME, '.cursor', 'bin'),
  ]))

function cursorFileUrl(folder) {
  const normalized = String(folder || '').replace(/\\/g, '/')
  if (!path.isAbsolute(folder || '')) return ''
  return `cursor://file${normalized.split('/').map(encodeURIComponent).join('/')}`
}

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let value = n
  for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[n] = value >>> 0
}
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function zipStore(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const central = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, end])
}

let installedVersion = ''
let extensionProblem = ''
async function installOpenExtension(bin) {
  const packageJson = JSON.parse(await fsp.readFile(path.join(EXTENSION_DIR, 'package.json'), 'utf8'))
  const extensionId = `${packageJson.publisher}.${packageJson.name}`
  if (installedVersion === packageJson.version) return
  try {
    const { stdout } = await execFileAsync(bin, ['--list-extensions', '--show-versions'], { timeout: 15000 })
    if (stdout.split(/\r?\n/).includes(`${extensionId}@${packageJson.version}`)) {
      installedVersion = packageJson.version
      extensionProblem = ''
      return
    }
  } catch {
    /* installation below gives the actionable result */
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-vsix-'))
  const vsix = path.join(tmp, `${extensionId}-${packageJson.version}.vsix`)
  const manifest = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata><Identity Language="en-US" Id="${packageJson.name}" Version="${packageJson.version}" Publisher="${packageJson.publisher}" />
  <DisplayName>${packageJson.displayName}</DisplayName><Description>${packageJson.description}</Description>
  <Categories>Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${packageJson.engines.vscode}" />
  <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" /></Properties></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>`)
  const contentTypes = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/><Default Extension="vsixmanifest" ContentType="text/xml"/>
<Default Extension="js" ContentType="application/javascript"/><Default Extension="xml" ContentType="text/xml"/>
</Types>`)
  try {
    const archive = zipStore([
      ['extension.vsixmanifest', manifest],
      ['[Content_Types].xml', contentTypes],
      ['extension/package.json', Buffer.from(JSON.stringify(packageJson))],
      ['extension/extension.js', await fsp.readFile(path.join(EXTENSION_DIR, 'extension.js'))],
    ])
    await fsp.writeFile(vsix, archive, { mode: 0o600 })
    await execFileAsync(bin, ['--install-extension', vsix, '--force'], { timeout: 30000 })
    installedVersion = packageJson.version
    extensionProblem = ''
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

async function writeOpenRequest(composerId, workspacePath) {
  const requestId = randomUUID()
  const payload = `${JSON.stringify({ requestId, composerId, workspacePath, at: Date.now() })}\n`
  await fsp.mkdir(path.dirname(OPEN_REQUEST), { recursive: true })
  const tmp = `${OPEN_REQUEST}.${process.pid}.${requestId}.tmp`
  await fsp.writeFile(tmp, payload, { mode: 0o600 })
  await fsp.rename(tmp, OPEN_REQUEST)
}

async function openThread(ref) {
  const composerId = ref?.composerId
  if (typeof composerId !== 'string' || !UUID.test(composerId)) {
    return { ok: false, error: 'No openable Cursor composer id on that thread' }
  }
  const folder =
    typeof ref?.workspacePath === 'string' && path.isAbsolute(ref.workspacePath)
      ? ref.workspacePath
      : typeof ref?.projectPath === 'string' && path.isAbsolute(ref.projectPath)
        ? ref.projectPath
        : ''
  const url = cursorFileUrl(folder)
  if (!url) return { ok: false, error: 'That Cursor thread has no absolute workspace path' }

  const bin = await findCursorBin()
  if (bin) {
    try {
      await installOpenExtension(bin)
    } catch (error) {
      extensionProblem = `Cursor opened the workspace, but its thread helper could not be installed: ${error?.message || error}`
    }
  } else {
    extensionProblem =
      'Cursor CLI not found on PATH or ~/.cursor/bin; install tools/cursor-open-extension manually to focus individual threads'
  }
  try {
    await writeOpenRequest(composerId, folder)
  } catch (error) {
    extensionProblem = `Cursor opened the workspace, but its thread-focus request could not be written: ${error?.message || error}`
  }
  return {
    ok: true,
    url,
    ...(bin ? { command: { argv: [bin, folder], cwd: folder } } : {}),
  }
}

/** `cursor://file/<abs>` is answered by the installed app; the OS opener does the finding. */
function newSession(dir) {
  const url = cursorFileUrl(dir)
  if (!url) return { ok: false, error: 'That folder is not somewhere Cursor can open' }
  return { ok: true, url }
}

const detect = async () => (await exists(PROJECTS)) || (await exists(STATE_DB))

async function diagnostic() {
  if (await exists(STATE_DB)) await databaseRows()
  if (databaseProblem) return databaseProblem
  if (extensionProblem) return extensionProblem
  if ((await exists(STATE_DB)) && !(await sqliteApi())?.DatabaseSync) {
    return `Cursor sidebar metadata needs Node 22.13 or newer (running ${process.versions.node})`
  }
  if (!(await findCursorBin())) {
    return 'Cursor CLI not found on PATH or ~/.cursor/bin; install tools/cursor-open-extension manually for per-thread focus'
  }
  return ''
}

export default {
  id: 'cursor',
  name: 'Cursor',
  detect,
  diagnostic,
  scanThreads,
  openThread,
  newSession,
  paths: { PROJECTS, STATE_DB, OPEN_REQUEST },
}
