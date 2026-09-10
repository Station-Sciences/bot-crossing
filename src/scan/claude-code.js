/**
 * Harness adapter: Claude Code, read in the browser.
 *
 * The sibling of `server/harnesses/claude-code.mjs`, over a directory handle for `~/.claude`
 * instead of the Node filesystem. It reads the two stores the CLI keeps there — one
 * transcript per session under `projects/<encoded-cwd>/<id>.jsonl`, and one small record per
 * live process under `sessions/` — and hands back the same `Thread` shape the server adapter
 * does, so the colony draws them identically.
 *
 * What it cannot read is the desktop app's own records: those live under
 * `~/Library/Application Support`, which the browser refuses to open. The desktop app runs
 * every thread through the CLI, so the transcript is here for all of them and the map is
 * complete; what goes missing is the app's decoration — starred, the merged-PR state, the
 * error flag, and the `local_…` id its deep link wants. A thread the app started is therefore
 * marked as not openable from here rather than handed a `resume` link, which would import a
 * duplicate into the app.
 *
 * Read-only, without exception, like every adapter.
 */
import { getDir, jsonLines, listDirs, listFiles, num, readHead, readTail, readText, stat } from './fs-handle.js'

export const ID_PREFIX = 'claude-code'
const ID = (raw) => `${ID_PREFIX}:${raw}`

const HEAD_BYTES = 192 * 1024
const TAIL_BYTES = 64 * 1024
/** How recently a session must have done something to count as "active now". See the server adapter. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
 * Pull whatever a transcript knows about itself: title, cwd, branch, start time, and which
 * front end started it. Mirrors the CLI's own title precedence: custom > ai > summary > first prompt.
 */
function readTranscriptMeta(records) {
  const meta = {
    customTitle: '',
    aiTitle: '',
    summary: '',
    firstPrompt: '',
    cwd: '',
    gitBranch: '',
    startedAt: 0,
    entrypoint: '',
  }
  for (const r of records) {
    if (!meta.customTitle && r.customTitle) meta.customTitle = r.customTitle
    if (!meta.aiTitle && r.aiTitle) meta.aiTitle = r.aiTitle
    if (!meta.summary && r.type === 'summary' && r.summary) meta.summary = r.summary
    if (!meta.cwd && r.cwd) meta.cwd = r.cwd
    if (!meta.gitBranch && r.gitBranch && r.gitBranch !== 'HEAD') meta.gitBranch = r.gitBranch
    if (!meta.entrypoint && typeof r.entrypoint === 'string') meta.entrypoint = r.entrypoint
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

const basename = (p) => {
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

/** `/repo/.claude/worktrees/feature-abc` -> project `/repo`, worktree `feature-abc`. */
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/
function splitWorktree(cwd) {
  const m = WORKTREE.exec(cwd)
  if (!m) return { root: cwd, worktree: '' }
  return { root: cwd.slice(0, m.index), worktree: m[1] }
}

function projectOf(cwd) {
  const { root, worktree } = splitWorktree(cwd || '')
  const projectPath = root || cwd || ''
  return { projectPath, project: basename(projectPath) || projectPath || 'unknown', worktree }
}

/** Best-effort reverse of the CLI's project folder encoding: `-Users-you-Some-Dir`, `C--Users-you-Some-Dir`. */
function decodeProjectDir(name) {
  const drive = /^([A-Za-z])--(.*)$/.exec(name)
  if (drive) return `${drive[1]}:\\${drive[2].replace(/-/g, '\\')}`
  return name.startsWith('-') ? '/' + name.slice(1).replace(/-/g, '/') : name
}

/**
 * Whether a transcript ends with the turn handed back to you. A last assistant message that
 * called a tool is mid-turn; one that called nothing has handed the turn back.
 */
async function awaitingReply(fileHandle) {
  let records
  try {
    records = jsonLines(await readTail(fileHandle, TAIL_BYTES))
  } catch {
    return false
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.type === 'user') return false
    if (r.type !== 'assistant') continue
    const content = r.message?.content
    const calling = Array.isArray(content) && content.some((c) => c?.type === 'tool_use')
    return !calling && r.message?.stop_reason !== 'tool_use'
  }
  return false
}

/** Transcript metadata is expensive to parse, so it is kept until the file changes. */
const metaCache = new Map()
async function transcriptMeta(entry) {
  const cached = metaCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime) return cached.meta
  let meta
  try {
    meta = readTranscriptMeta(jsonLines(await readHead(entry.handle, HEAD_BYTES)))
  } catch {
    meta = readTranscriptMeta([])
  }
  metaCache.set(entry.id, { mtime: entry.mtime, meta })
  return meta
}

/** Same for the tail: whose turn it is only changes when the file does. */
const tailCache = new Map()
async function waitingFor(entry) {
  const cached = tailCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime) return cached.waiting
  const waiting = await awaitingReply(entry.handle)
  tailCache.set(entry.id, { mtime: entry.mtime, waiting })
  return waiting
}

/** Index every transcript under `projects/`, keyed by session id. */
async function scanTranscripts(root) {
  const byId = new Map()
  const projects = await getDir(root, 'projects')
  if (!projects) return byId
  for (const projectDir of await listDirs(projects)) {
    for (const file of await listFiles(projectDir.handle, (n) => n.endsWith('.jsonl'))) {
      const id = file.name.slice(0, -'.jsonl'.length)
      if (!UUID.test(id)) continue
      let info
      try {
        info = await stat(file.handle)
      } catch {
        continue
      }
      byId.set(id, { id, handle: file.handle, projectDir: projectDir.name, size: info.size, mtime: info.mtime })
    }
  }
  return byId
}

/**
 * Sessions the CLI has a process record for. The registry keeps files for processes that have
 * exited and a page cannot probe a pid, so a record only ever counts together with a
 * transcript that moved inside the active window.
 */
async function scanLiveSessions(root) {
  const live = new Set()
  const sessions = await getDir(root, 'sessions')
  if (!sessions) return live
  for (const file of await listFiles(sessions, (n) => n.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readText(file.handle))
      if (record.sessionId && record.pid) live.add(record.sessionId)
    } catch {
      /* a record mid-write — skip this pass */
    }
  }
  return live
}

/** Does this folder look like `~/.claude`? Either store is enough. */
export async function looksLikeClaudeHome(root) {
  return Boolean((await getDir(root, 'projects')) || (await getDir(root, 'sessions')))
}

export async function scanThreads(root) {
  const [transcripts, live] = await Promise.all([scanTranscripts(root), scanLiveSessions(root)])
  const now = Date.now()
  const threads = []
  for (const [id, entry] of transcripts) {
    const meta = await transcriptMeta(entry)
    const cwd = meta.cwd || decodeProjectDir(entry.projectDir)
    const { projectPath, project, worktree } = projectOf(cwd)
    const fromDesktop = meta.entrypoint === 'claude-desktop'
    const fresh = now - entry.mtime < ACTIVE_WINDOW_MS
    const hasLiveProcess = live.has(id)
    const waiting = hasLiveProcess && fresh ? await waitingFor(entry) : false
    threads.push({
      id: ID(id),
      harness: ID_PREFIX,
      harnessName: 'Claude Code',
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
      running: hasLiveProcess && fresh && !waiting,
      // A thread that handed the turn back wants you — the only way a thread can ask for
      // anything from here, since the app's focus history is out of reach.
      unread: waiting,
      hasError: false,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: entry.size,
      source: fromDesktop ? 'desktop' : 'cli',
      // `resume` imports the transcript, which makes the app write a second, untitled copy of
      // a thread it already has. Only a terminal-started thread is safe to hand it.
      canOpen: !fromDesktop,
      openUrl: fromDesktop ? '' : `claude://resume?session=${id}`,
      openHint: fromDesktop ? 'Started in the Claude app — open it from the list there' : '',
      ref: { cliSessionId: id, cwd },
    })
  }
  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return threads
}

/** A brand new thread rooted in a repo: the app opens an empty session with that folder as its workspace. */
export const newSessionUrl = (dir) => `claude://code/new?${new URLSearchParams({ folder: dir })}`

export default {
  id: ID_PREFIX,
  name: 'Claude Code',
  folder: '.claude',
  looksLike: looksLikeClaudeHome,
  scanThreads,
  newSessionUrl,
}
