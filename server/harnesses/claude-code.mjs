/**
 * Harness adapter: Claude Code (Anthropic) — the desktop app and the CLI together.
 *
 * Everything that knows the shape of Claude Code's own files lives in this one module.
 * `server/scan.mjs` never reaches past the adapter interface, so adding another harness
 * means writing a sibling of this file rather than editing the scanner. The contract is
 * written down in `server/harnesses/README.md`.
 *
 * Two stores, deliberately merged rather than picked between:
 *   - the desktop app keeps one JSON record per thread (title, cwd, model, timestamps)
 *   - the CLI keeps the raw transcript, which is the only source for terminal-started work
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { exists, jsonLines, listDirs, listFiles, num, readHead, readTail } from '../lib/fsutil.mjs'

const execFileAsync = promisify(execFile)
const HOME = os.homedir()

/**
 * Where the Claude desktop app keeps its data: Electron's `userData` for an app named
 * "Claude", which lands somewhere different on each OS.
 */
function desktopDataDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude')
    case 'linux':
      return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Claude')
    default:
      return path.join(HOME, 'Library', 'Application Support', 'Claude')
  }
}

/** Where the Claude desktop app keeps one JSON record per thread. */
const DESKTOP_SESSIONS = path.join(desktopDataDir(), 'claude-code-sessions')
/** Where the CLI keeps the raw transcript: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl */
const CLI_PROJECTS = path.join(HOME, '.claude', 'projects')
/** One file per live CLI process: {pid, sessionId, cwd, ...}. Stale files outlive their pid. */
const CLI_LIVE = path.join(HOME, '.claude', 'sessions')

const HEAD_BYTES = 192 * 1024

/**
 * How recently a session must have done something to count as "active now".
 * A live process on its own is not enough: the desktop app pre-warms idle sessions, so
 * threads untouched for days still hold a CLI process. Measured against real data, the
 * warmed ones sat 16 hours to 3 days idle while genuinely active work was minutes old.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DESKTOP_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function firstText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') return part
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text
    }
  }
  return ''
}

/** Strip <system-reminder>/<command-*> noise the CLI wraps around prompts. */
function cleanPrompt(s) {
  return String(s)
    .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pull whatever a transcript knows about itself: title, cwd, branch, start time.
 * Mirrors the CLI's own title precedence: custom > ai > summary > first prompt.
 */
function readTranscriptMeta(records) {
  const meta = { customTitle: '', aiTitle: '', summary: '', firstPrompt: '', cwd: '', gitBranch: '', startedAt: 0 }
  for (const r of records) {
    if (!meta.customTitle && r.customTitle) meta.customTitle = r.customTitle
    if (!meta.aiTitle && r.aiTitle) meta.aiTitle = r.aiTitle
    if (!meta.summary && r.type === 'summary' && r.summary) meta.summary = r.summary
    if (!meta.cwd && r.cwd) meta.cwd = r.cwd
    if (!meta.gitBranch && r.gitBranch && r.gitBranch !== 'HEAD') meta.gitBranch = r.gitBranch
    if (!meta.startedAt && r.timestamp) {
      const t = Date.parse(r.timestamp)
      if (!Number.isNaN(t)) meta.startedAt = t
    }
    if (!meta.firstPrompt && r.type === 'user' && r.message) {
      const text = cleanPrompt(firstText(r.message.content))
      if (text && !text.startsWith('<')) meta.firstPrompt = text
    }
  }
  return meta
}

/**
 * `/repo/.claude/worktrees/feature-abc` -> project `/repo`, worktree `feature-abc`.
 * Either separator: on Windows the same cwd arrives as `C:\repo\.claude\worktrees\…`.
 */
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/
function splitWorktree(cwd) {
  const m = WORKTREE.exec(cwd)
  if (!m) return { root: cwd, worktree: '' }
  return { root: cwd.slice(0, m.index), worktree: m[1] }
}

function projectOf(cwd, originCwd) {
  const { root, worktree } = splitWorktree(cwd || '')
  const projectPath = originCwd || root || cwd || ''
  return { projectPath, project: path.basename(projectPath) || projectPath || 'unknown', worktree }
}

/**
 * Best-effort reverse of the encoding used for project folder names: `-Users-you-Some-Dir`
 * on macOS, `C--Users-you-Some-Dir` on Windows, where the drive's colon became a dash too.
 */
function decodeProjectDir(name) {
  const drive = /^([A-Za-z])--(.*)$/.exec(name)
  if (drive) return `${drive[1]}:\\${drive[2].replace(/-/g, '\\')}`
  return name.startsWith('-') ? '/' + name.slice(1).replace(/-/g, '/') : name
}

/** Index every CLI transcript on disk, keyed by session id. */
async function scanTranscripts() {
  const byId = new Map()
  for (const projectDir of await listDirs(CLI_PROJECTS)) {
    for (const file of await listFiles(projectDir, (n) => n.endsWith('.jsonl'))) {
      const id = path.basename(file, '.jsonl')
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      byId.set(id, { id, file, projectDir, size: stat.size, mtime: stat.mtimeMs })
    }
  }
  return byId
}

/** How much of a transcript's end it takes to see whose turn it is. One record is plenty. */
const TAIL_BYTES = 64 * 1024

/**
 * Whether a transcript ends with the turn handed back to you.
 *
 * A live process is not the same thing as work in progress. The CLI holds its process open
 * while it sits at the prompt, so "the pid exists and the file moved recently" marks a thread
 * that finished four minutes ago and asked you a question as *working* — an astronaut
 * hammering away at a thread whose whole point is that it is waiting.
 *
 * The transcript says which it is. A last assistant message that called a tool is mid-turn;
 * one that called nothing has handed the turn back and the reply is yours to make. Note that
 * `stop_reason` alone will not do — it is `end_turn` on a main thread's last message and
 * empty on some others — so what the message *called* is the half worth testing.
 *
 * Reads the tail rather than the whole file, and only for threads that could plausibly be
 * running, so it costs one small read each.
 */
async function awaitingReply(file) {
  let records
  try {
    records = jsonLines(await readTail(file, TAIL_BYTES))
  } catch {
    return false
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    // A user turn, a tool result or an attachment all mean the model is expected to speak
    // next — whatever the process is doing, it is not waiting on anyone.
    if (r.type === 'user') return false
    if (r.type !== 'assistant') continue
    const content = r.message?.content
    const calling = Array.isArray(content) && content.some((c) => c?.type === 'tool_use')
    return !calling && r.message?.stop_reason !== 'tool_use'
  }
  return false
}

/** Transcript metadata is expensive to parse, so keep it until the file changes. */
const metaCache = new Map()
async function transcriptMeta(entry) {
  const cached = metaCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime) return cached.meta
  let meta
  try {
    meta = readTranscriptMeta(jsonLines(await readHead(entry.file, HEAD_BYTES)))
  } catch {
    meta = readTranscriptMeta([])
  }
  metaCache.set(entry.id, { mtime: entry.mtime, meta })
  return meta
}

/**
 * Sessions with a CLI process actually alive right now. The registry keeps files for
 * processes that have exited, so every pid is probed before it counts.
 */
async function scanLiveSessions() {
  const live = new Set()
  for (const file of await listFiles(CLI_LIVE, (n) => n.endsWith('.json'))) {
    let record
    try {
      record = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (!record.sessionId || !record.pid) continue
    try {
      process.kill(record.pid, 0) // signal 0 only tests for existence
      live.add(record.sessionId)
    } catch {
      /* process is gone */
    }
  }
  return live
}

/** Every thread the desktop app has a record for. */
async function scanDesktopSessions() {
  const out = []
  for (const account of await listDirs(DESKTOP_SESSIONS)) {
    for (const org of await listDirs(account)) {
      for (const file of await listFiles(org, (n) => n.startsWith('local_') && n.endsWith('.json'))) {
        try {
          out.push(JSON.parse(await fsp.readFile(file, 'utf8')))
        } catch {
          /* a session mid-write — skip this pass */
        }
      }
    }
  }
  return out
}

/**
 * Two desktop records can point at one transcript — resuming a thread that is already
 * open makes the app write a second, untitled record. Keep the richer of the two.
 */
function mergeThread(existing, next) {
  const better = (a, b) => (a && a !== 'Untitled thread' ? a : b || a)
  // The titled record is the real thread; an untitled twin is the import ghost. Point
  // the canonical id at the real one, but keep both so archiving covers the ghost too.
  const keepExisting = existing.titled || !next.titled
  return {
    ...existing,
    ...next,
    title: better(existing.title, next.title),
    titled: existing.titled || next.titled,
    preview: existing.preview || next.preview,
    desktopSessionId: keepExisting ? existing.desktopSessionId : next.desktopSessionId,
    desktopSessionIds: [...new Set([...existing.desktopSessionIds, ...next.desktopSessionIds])],
    bridgeSessionId: existing.bridgeSessionId || next.bridgeSessionId,
    model: existing.model || next.model,
    effort: existing.effort || next.effort,
    gitBranch: existing.gitBranch || next.gitBranch,
    cwd: existing.cwd || next.cwd,
    createdAt: Math.min(existing.createdAt || Infinity, next.createdAt || Infinity) || 0,
    lastActivityAt: Math.max(existing.lastActivityAt || 0, next.lastActivityAt || 0),
    lastFocusedAt: Math.max(existing.lastFocusedAt || 0, next.lastFocusedAt || 0),
    hasError: existing.hasError || next.hasError,
    hasLiveProcess: existing.hasLiveProcess || next.hasLiveProcess,
    starred: existing.starred || next.starred,
    routine: existing.routine || next.routine,
    prState: existing.prState || next.prState,
    archived: existing.archived && next.archived,
    hasTranscript: existing.hasTranscript || next.hasTranscript,
  }
}

/**
 * Fold the adapter's private bookkeeping into the shape the rest of the app sees.
 * The session ids stay, but behind `ref` — an opaque blob the browser hands straight
 * back on open/archive, so nothing outside this file has to know what a Claude session
 * id looks like.
 */
function toThread(t) {
  const {
    desktopSessionId,
    desktopSessionIds,
    cliSessionId,
    bridgeSessionId,
    titled,
    hasLiveProcess,
    transcriptFile,
    recordActivityAt,
    ...rest
  } = t
  return {
    ...rest,
    canOpen: Boolean((desktopSessionId && DESKTOP_ID.test(desktopSessionId)) || (cliSessionId && UUID.test(cliSessionId))),
    canArchive: desktopSessionIds.length > 0,
    ref: { desktopSessionId, desktopSessionIds, cliSessionId },
  }
}

async function scanThreads() {
  const [desktop, transcripts, live] = await Promise.all([
    scanDesktopSessions(),
    scanTranscripts(),
    scanLiveSessions(),
  ])
  const byId = new Map()
  const add = (thread) => {
    const existing = byId.get(thread.id)
    byId.set(thread.id, existing ? mergeThread(existing, thread) : thread)
  }
  const claimed = new Set()

  for (const s of desktop) {
    const cliSessionId = s.cliSessionId || ''
    const entry = cliSessionId ? transcripts.get(cliSessionId) : null
    if (entry) claimed.add(cliSessionId)

    const cwd = s.cwd || s.originCwd || ''
    const { projectPath, project, worktree } = projectOf(cwd, s.originCwd)
    const meta = entry ? await transcriptMeta(entry) : null

    add({
      id: cliSessionId || s.sessionId,
      cliSessionId,
      desktopSessionId: s.sessionId || '',
      desktopSessionIds: s.sessionId ? [s.sessionId] : [],
      titled: Boolean(s.title),
      bridgeSessionId: (s.bridgeSessionIds && s.bridgeSessionIds[0]) || '',
      title: s.title || meta?.customTitle || meta?.aiTitle || meta?.summary || meta?.firstPrompt || 'Untitled thread',
      preview: meta?.firstPrompt ? meta.firstPrompt.slice(0, 240) : '',
      project,
      projectPath,
      worktree,
      cwd,
      gitBranch: meta?.gitBranch || '',
      model: s.model || '',
      effort: s.effort || '',
      createdAt: num(s.createdAt) || meta?.startedAt || 0,
      // The desktop record's own timestamp lags: the app writes it when the thread is
      // focused, so a session running in a terminal — or in a window you are not looking at
      // — reads as hours old while its transcript is being written to right now. Whichever
      // of the two is later is the truth about when the thread last did anything.
      lastActivityAt: Math.max(
        num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
        entry?.mtime || 0
      ),
      // The record's own timestamp, kept apart from the one above. "Unread" is a comparison
      // against when you last *looked*, and both sides of it have to come from the app's own
      // bookkeeping: measure the transcript's mtime against `lastFocusedAt` instead and every
      // thread whose file was touched after you last opened it — a resumed CLI session, a
      // background write — reads as unread, which puts a `?` over half the colony.
      recordActivityAt: num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
      lastFocusedAt: num(s.lastFocusedAt),
      hasLiveProcess: live.has(cliSessionId),
      hasError: Boolean(s.error),
      starred: s.isStarred === true,
      routine: s.scheduledTaskId || '',
      prState: s.prState || '',
      archived: s.isArchived === true || s.isArchived === 'True',
      hasTranscript: Boolean(entry),
      sizeBytes: entry?.size || 0,
      transcriptFile: entry?.file || '',
      source: 'desktop',
    })
  }

  // Transcripts with no desktop record — usually threads started straight from the terminal.
  for (const [id, entry] of transcripts) {
    if (claimed.has(id)) continue
    const meta = await transcriptMeta(entry)
    const cwd = meta.cwd || decodeProjectDir(path.basename(entry.projectDir))
    const { projectPath, project, worktree } = projectOf(cwd, '')
    add({
      id,
      cliSessionId: id,
      desktopSessionId: '',
      desktopSessionIds: [],
      titled: Boolean(meta.customTitle || meta.aiTitle),
      bridgeSessionId: '',
      title: meta.customTitle || meta.aiTitle || meta.summary || meta.firstPrompt || 'Untitled thread',
      preview: meta.firstPrompt ? meta.firstPrompt.slice(0, 240) : '',
      project,
      projectPath,
      worktree,
      cwd,
      gitBranch: meta.gitBranch,
      model: '',
      effort: '',
      createdAt: meta.startedAt || entry.mtime,
      lastActivityAt: entry.mtime,
      lastFocusedAt: 0,
      hasLiveProcess: live.has(id),
      hasError: false,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      hasTranscript: true,
      sizeBytes: entry.size,
      transcriptFile: entry.file,
      source: 'cli',
    })
  }

  const threads = [...byId.values()]
  // Unread = the thread moved on after you last looked at it; never opened counts as unread.
  // Terminal-only threads have no focus history at all, so "unread" is unknowable — not true.
  const now = Date.now()
  for (const thread of threads) {
    const seenAt = thread.recordActivityAt ?? thread.lastActivityAt
    thread.unread = thread.desktopSessionIds.length > 0 && seenAt > thread.lastFocusedAt
    const fresh = now - thread.lastActivityAt < ACTIVE_WINDOW_MS
    // Only threads that could plausibly be working pay for the tail read.
    const waiting =
      thread.hasLiveProcess && fresh && thread.transcriptFile ? await awaitingReply(thread.transcriptFile) : false
    thread.running = thread.hasLiveProcess && fresh && !waiting
    // A thread that handed the turn back wants you, whether or not the desktop app has ever
    // seen it — which is the only way a terminal-only thread can ask for anything at all.
    if (waiting) thread.unread = true
  }
  return threads.map(toThread)
}

/** Locate the desktop app's record for a session. Id is pattern-checked, never joined raw. */
async function findSessionFile(sessionId) {
  if (!DESKTOP_ID.test(sessionId)) return null
  for (const account of await listDirs(DESKTOP_SESSIONS)) {
    for (const org of await listDirs(account)) {
      const file = path.join(org, `${sessionId}.json`)
      if (await exists(file)) return file
    }
  }
  return null
}

/**
 * Flip `isArchived` on the desktop app's own session record — the same field its
 * Archived list reads. Only that one key is touched; everything else is written back
 * byte-for-byte from what was there, through a temp file so a crash can't truncate it.
 */
async function setSessionArchived(sessionId, archived) {
  const file = await findSessionFile(sessionId)
  if (!file) return { ok: false, error: 'No Claude Code session record for that thread' }

  let record
  try {
    record = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return { ok: false, error: 'Session record is unreadable' }
  }
  if (!record || typeof record !== 'object' || record.sessionId !== sessionId) {
    return { ok: false, error: 'Session record did not look like the expected session' }
  }

  record.isArchived = Boolean(archived)
  const tmp = `${file}.botcrossing.tmp`
  await fsp.writeFile(tmp, JSON.stringify(record, null, 2))
  await fsp.rename(tmp, file)
  metaCache.delete(record.cliSessionId)
  return { ok: true, file, archived: Boolean(archived) }
}

/** Archive every record that maps to a thread — the real one and any import ghosts. */
async function setArchived(ref, archived) {
  const ids = ref?.desktopSessionIds || []
  if (!ids.length) return { ok: false, error: 'No session records for that thread' }
  const results = []
  for (const id of ids) results.push(await setSessionArchived(id, archived))
  const ok = results.some((r) => r.ok)
  return ok
    ? { ok, archived: Boolean(archived), records: results.filter((r) => r.ok).length }
    : results[0] || { ok: false, error: 'No session records for that thread' }
}

/**
 * Hands the thread back to Claude Code. `epitaxy/<local_…>` *navigates* the desktop app
 * to a thread it already has; `resume` *imports* the transcript, which spawns a second
 * untitled session and rewrites the .jsonl — so it is only ever the fallback for threads
 * the app has never seen. Ids are pattern-checked before they reach the opener.
 */
function openThread(ref) {
  const { desktopSessionId, cliSessionId } = ref || {}
  if (desktopSessionId && DESKTOP_ID.test(desktopSessionId)) {
    return { ok: true, url: `claude://claude.ai/epitaxy/${desktopSessionId}` }
  }
  if (cliSessionId && UUID.test(cliSessionId)) {
    return { ok: true, url: `claude://resume?session=${cliSessionId}` }
  }
  return { ok: false, error: 'No openable session id on that thread' }
}

/**
 * A brand new thread rooted in a repo — the same `code/new?folder=` deep link Finder's
 * "New Claude Code Session Here" quick action uses. Nothing is resumed and nothing is
 * written: the desktop app just opens an empty session with that folder as its workspace.
 */
function newSession(dir) {
  return { ok: true, url: `claude://code/new?${new URLSearchParams({ folder: dir })}` }
}

/**
 * When the Claude desktop app last launched. It loads every session record into memory at
 * startup and never re-reads them, so this timestamp is the line between an archive it has
 * seen and one still waiting on disk.
 */
let appStartCache = { at: 0, checkedAt: 0 }
async function appStartedAt() {
  const now = Date.now()
  if (now - appStartCache.checkedAt < 15000) return appStartCache.at

  let started = 0
  try {
    started = process.platform === 'win32' ? await windowsAppStartedAt() : await darwinAppStartedAt()
  } catch {
    /* no process listing — treat the app as never having restarted */
  }
  appStartCache = { at: started, checkedAt: now }
  return started
}

async function darwinAppStartedAt() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,lstart=,command='], { maxBuffer: 8 * 1024 * 1024 })
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*\d+\s+(\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(\/.*)$/)
    if (!m) continue
    const [, when, command] = m
    // The main process only — helper processes carry a --type= flag.
    if (!command.includes('/Claude.app/Contents/MacOS/Claude') || command.includes('--type=')) continue
    const parsed = Date.parse(when)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

/**
 * The same answer on Windows. There is no `ps`, and `tasklist` knows neither start times nor
 * command lines, so this asks CIM, which knows both. The desktop app and the CLI are both
 * `claude.exe` here, so the main process is picked out by shape rather than by path: the one
 * with no `--type=` flag whose children (the helpers, which all carry one) point back at it.
 * A PowerShell round trip is a few hundred milliseconds, which the 15s cache above absorbs.
 */
async function windowsAppStartedAt() {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object {",
    "  if ($_.CreationDate) { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId,",
    "    $_.CreationDate.ToUniversalTime().ToString('o'), $_.CommandLine } }",
  ].join(' ')
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    maxBuffer: 8 * 1024 * 1024,
  })
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => line.split('|'))
    .filter((parts) => parts.length >= 4)
    .map(([pid, ppid, when, ...command]) => ({
      pid,
      ppid,
      when: Date.parse(when),
      command: command.join('|'),
    }))
  const helperParents = new Set(rows.filter((r) => r.command.includes('--type=')).map((r) => r.ppid))
  const main = rows.find((r) => helperParents.has(r.pid) && !r.command.includes('--type='))
  return main && !Number.isNaN(main.when) ? main.when : 0
}

export default {
  id: 'claude-code',
  name: 'Claude Code',
  /** Only claim this machine if one of the two stores is actually there. */
  detect: async () => (await exists(DESKTOP_SESSIONS)) || (await exists(CLI_PROJECTS)),
  scanThreads,
  openThread,
  newSession,
  setArchived,
  appStartedAt,
  paths: { DESKTOP_SESSIONS, CLI_PROJECTS, CLI_LIVE },
}
