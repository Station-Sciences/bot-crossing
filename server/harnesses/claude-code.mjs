/**
 * Harness adapter: Claude Code (Anthropic) — the desktop app and the CLI together.
 *
 * Everything that knows the shape of Claude Code's own files lives in this one module.
 * `server/scan.mjs` never reaches past the adapter interface, so adding another harness
 * means writing a sibling of this file rather than editing the scanner. The contract is
 * written down in `server/harnesses/README.md`.
 *
 * Read-only, without exception. Nothing here writes to Claude Code's files — see the note on
 * archiving in `server/harnesses/README.md`.
 *
 * Two stores, deliberately merged rather than picked between:
 *   - the desktop app keeps one JSON record per thread (title, cwd, model, timestamps), and
 *     leaves a marker behind for each thread deleted in it
 *   - the CLI keeps the raw transcript, which is the only source for terminal-started work
 */
import fsp from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exists, findExecutable, jsonLines, listDirs, listFiles, num, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/**
 * Where Electron puts `userData` on each OS. The Claude desktop app's own folder is one level
 * below, named after the app — see `desktopStores` for why that name is not a constant.
 *
 * On Windows there are two answers, because the app ships two ways. The classic installer writes
 * to `%APPDATA%`, which is what Electron's `userData` means everywhere else. Installed from the
 * Microsoft Store the app is an MSIX package, and MSIX *redirects* what a packaged app believes is
 * `%APPDATA%` into its own private `…\Packages\<family>\LocalCache\Roaming`. The app is installed,
 * running and writing session records — and `%APPDATA%\Claude` does not exist at all.
 *
 * The package folder is globbed rather than named: its suffix is a hash of the publisher, and
 * hard-coding that buys a constant which is right until it is not, and then wrong in a way that
 * looks exactly like the app having been uninstalled.
 */
function userDataRoots() {
  switch (process.platform) {
    case 'win32': {
      const roots = [process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')]
      const packages = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Packages')
      for (const name of dirNames(packages)) {
        if (name.startsWith('Claude_')) roots.push(path.join(packages, name, 'LocalCache', 'Roaming'))
      }
      return roots
    }
    case 'linux':
      return [process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')]
    default:
      return [path.join(HOME, 'Library', 'Application Support')]
  }
}

function dirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Every session store the desktop app has written, as a list.
 *
 * The app's folder is not always called `Claude`. macOS ships it as `Claude-3p` too, and a second
 * desktop profile gets a folder of its own, `Claude-<profile>`, beside the first. Two can be live
 * at once, and an older install leaves a `Claude` behind that still holds a handful of records and
 * its deletion markers. Picking the first folder that had records meant reading that leftover and
 * missing the one in use: on one Windows machine that was 4 records of 103, so nearly every thread
 * lost its title and `Open` fell back to `claude://resume`, which imports a copy of the thread
 * rather than navigating to it.
 *
 * So every `Claude*` folder holding a `claude-code-sessions` store is read, and the scan merges
 * them the way it already merges two records for one transcript.
 *
 * Resolved once, at import. Installing the app while the colony is running therefore wants a
 * restart to be noticed — a knowing trade, since the alternative is globbing these folders on
 * every scan to catch something that happens once. When nothing is found, the classic path stands
 * in so every caller still works against a real path, which `detect()` reads as "no app".
 */
function desktopStores() {
  if (process.env.BOT_CROSSING_CLAUDE_DESKTOP) return [process.env.BOT_CROSSING_CLAUDE_DESKTOP]
  const roots = userDataRoots()
  const found = []
  for (const root of roots) {
    for (const name of dirNames(root)) {
      if (!/^Claude(?:$|[-_ ])/.test(name)) continue
      const store = path.join(root, name, 'claude-code-sessions')
      if (existsSync(store)) found.push(store)
    }
  }
  return found.length ? found : [path.join(roots[0], 'Claude', 'claude-code-sessions')]
}

/**
 * Both roots take an override, which is how the tests fake an install without touching a real
 * one. `CLAUDE_CONFIG_DIR` is the CLI's own: a shell that sets it has its transcripts written
 * there, so the variable that moves the CLI's home moves where the colony looks for it too.
 * `BOT_CROSSING_CLAUDE_DESKTOP` names the session store itself, the sibling of Cursor's
 * `BOT_CROSSING_CURSOR_PROJECTS`.
 */
/** Where the Claude desktop app keeps one JSON record per thread — one store per app profile. */
const DESKTOP_STORES = desktopStores()
/** The CLI's home: `~/.claude`, unless the CLI itself has been told otherwise. */
const CLI_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude')
/** Where the CLI keeps the raw transcript: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl */
const CLI_PROJECTS = path.join(CLI_HOME, 'projects')
/** One file per live CLI process: {pid, sessionId, cwd, ...}. Stale files outlive their pid. */
const CLI_LIVE = path.join(CLI_HOME, 'sessions')

const HEAD_BYTES = 192 * 1024

/**
 * How recently a session must have done something to count as "active now".
 * A live process on its own is not enough: the desktop app pre-warms idle sessions, so
 * threads untouched for days still hold a CLI process. Measured against real data, the
 * warmed ones sat 16 hours to 3 days idle while genuinely active work was minutes old.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

/**
 * How long a subagent's transcript may sit untouched before its errand counts as abandoned.
 * A subagent runs inside its parent's process, so the pid probe the rest of this file uses does
 * not exist for it, and one that is thinking writes nothing for minutes at a time — at two or
 * three minutes they blink out while still working.
 */
const SUBAGENT_WINDOW_MS = 10 * 60 * 1000

/**
 * A brief can be long: 36 of 147 transcripts on this machine open with more than 8 KB, the
 * largest at 17 KB. `readHead` drops a trailing partial line, so a head that is too small yields
 * nothing at all rather than a truncated task.
 */
const SUBAGENT_HEAD_BYTES = 64 * 1024

/**
 * Every id this adapter hands out is prefixed. `server/harnesses/README.md` asks for ids unique
 * across harnesses, and while two UUIDs will not collide, the colony keys its archive list and
 * saved layout on this string — so it is worth being unambiguous rather than merely lucky.
 */
const ID = (raw) => `claude-code:${raw}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A title from a prompt, for a thread the desktop app never named: its first line that says
 * anything, and no more of it than every other harness keeps. The fallback used to hand back
 * the whole prompt — a headless orchestrator run opens with three kilobytes of instructions, and six
 * of those were a third of every poll's payload, laid out as a title.
 */
const TITLE_MAX = 120
export function titleFromPrompt(prompt) {
  const line = String(prompt || '')
    .split('\n')
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .find(Boolean)
  return line ? line.slice(0, TITLE_MAX) : 'Untitled thread'
}

const DESKTOP_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The type check matters wherever an id came back from the page: `RegExp.test` stringifies, so a
// one-element array holding a valid id would pass the pattern and then travel on as an array.
const isCliId = (v) => typeof v === 'string' && UUID.test(v)
const isDesktopId = (v) => typeof v === 'string' && DESKTOP_ID.test(v)

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

/** Strip <system-reminder>/<command-*> noise the CLI wraps around prompts, keeping line breaks. */
const stripNoise = (text) => String(text).replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')

/** A prompt as one line of text: the noise gone and every run of whitespace a single space. */
function cleanPrompt(text) {
  return stripNoise(text).replace(/\s+/g, ' ').trim()
}

/**
 * Pull whatever a transcript knows about itself: title, cwd, branch, start time.
 * Mirrors the CLI's own title precedence: custom > ai > summary > first prompt.
 */
function readTranscriptMeta(records) {
  const meta = {
    customTitle: '', aiTitle: '', summary: '', firstPrompt: '', promptTitle: '',
    cwd: '', gitBranch: '', startedAt: 0,
  }
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
      const raw = firstText(r.message.content)
      const text = cleanPrompt(raw)

      if (text && !text.startsWith('<')) {
        meta.firstPrompt = text
        // Taken here, from the raw text: `firstPrompt` has its line breaks collapsed, so a title
        // worked out from it later could never find the first line.
        meta.promptTitle = titleFromPrompt(stripNoise(raw))
      }
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

/**
 * The desktop app's throwaway sessions each get a fresh folder of their own,
 * `<userData>/scratch-workspaces/<account>/<org>/scratch-2026-09-22-a1b2c3`. Read as projects,
 * every one of them claimed a hex zone for a single bot — twenty-one zones on one machine — so
 * they share one plot, the way a repo's worktrees share its plot, and the folder rides along as
 * the worktree tag.
 */
const SCRATCH = /^(.*[\\/]scratch-workspaces)[\\/](?:[^\\/]+[\\/]){2}(scratch-[^\\/]+)[\\/]?$/

/** The folder that plot stands on: the app's own, so nothing is started in it. */
const SCRATCH_ROOT = /[\\/]scratch-workspaces[\\/]?$/

function projectOf(cwd, originCwd) {
  const scratch = SCRATCH.exec(originCwd || cwd || '')
  if (scratch) return { projectPath: scratch[1], project: 'Scratch', worktree: scratch[2] }
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

/**
 * Index every CLI transcript on disk, keyed by session id.
 *
 * A session id is only unique *per directory* it has ever run in — resuming it from a git
 * worktree, or any other second checkout, writes a second `<id>.jsonl` under a different
 * `projectDir` rather than moving the first. Without a tiebreaker the later `listDirs` entry
 * would win regardless of which copy is actually live, so a worktree's now-stale copy could
 * overwrite the real one just by sorting after it. The newer file is always the live one: an
 * abandoned copy stops being written to the moment the session moves on.
 */
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
      const existing = byId.get(id)
      if (existing && existing.mtime >= stat.mtimeMs) continue
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
 * A live process is not the same thing as work in progress. The CLI holds its process open while
 * it sits at the prompt, so "the pid exists and the file moved recently" marks a thread that
 * finished four minutes ago and asked you a question as *working* — an astronaut hammering away
 * at a thread whose whole point is that it is waiting.
 *
 * The transcript says which it is. A last assistant message that called a tool is mid-turn; one
 * that called nothing has handed the turn back and the reply is yours. `stop_reason` alone will
 * not do — it is `end_turn` on a main thread's last message and empty on some others — so what
 * the message *called* is the half worth testing.
 *
 * Only threads that could plausibly be running pay for this, so it costs one small read each.
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
    // A user turn, a tool result or an attachment all mean the model speaks next — whatever the
    // process is doing, it is not waiting on anyone.
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
  if (!meta.firstPrompt && entry.size > HEAD_BYTES) Object.assign(meta, await firstPromptPastHead(entry))
  metaCache.set(entry.id, { mtime: entry.mtime, meta })
  return meta
}

/**
 * How far to look for a first prompt the head did not reach. A prompt with a pasted screenshot
 * carries the image inline as base64, so the one record that names the thread can be hundreds of
 * KB by itself, and `readHead` drops it whole as a partial line. Attachments the CLI writes ahead
 * of it push it further out. 15 of 95 transcripts on this machine had their first prompt past the
 * head, between 291 KB and 1.2 MB in, bar one at 6.7 MB.
 */
const PROMPT_BYTES = 2 * 1024 * 1024

/** A first prompt never changes once written, so unlike `metaCache` this one ignores mtime. */
const promptCache = new Map()
async function firstPromptPastHead(entry) {
  if (promptCache.has(entry.id)) return promptCache.get(entry.id)
  let prompt = { firstPrompt: '', promptTitle: '' }
  try {
    const { firstPrompt, promptTitle } = readTranscriptMeta(
      jsonLines(await readHead(entry.file, Math.min(entry.size, PROMPT_BYTES)))
    )
    prompt = { firstPrompt, promptTitle }
  } catch {
    /* unreadable right now — the next change to the file tries again */
  }
  if (prompt.firstPrompt) promptCache.set(entry.id, prompt)
  return prompt
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

/** Briefs, kept until the file changes — the mtime cache `transcriptMeta` establishes. */
const subagentCache = new Map()

/** The prompt a parent handed its subagent, which is the only thing about an errand worth showing. */
async function subagentTask(file, mtime) {
  const cached = subagentCache.get(file)
  if (cached && cached.mtime === mtime) return cached.task
  let task = ''
  // Not simply the first record, and sometimes not there at all: a forked subagent opens with a
  // `fork-context-ref` and inherits its parent's context instead of being briefed, so it has no
  // task text to find. Same test `readTranscriptMeta` puts to a thread's first prompt.
  for (const record of jsonLines(await readHead(file, SUBAGENT_HEAD_BYTES).catch(() => ''))) {
    if (record.type !== 'user' || !record.message) continue
    const text = cleanPrompt(firstText(record.message.content))
    if (text && !text.startsWith('<')) {
      task = text
      break
    }
  }
  subagentCache.set(file, { mtime, task })
  return task
}

/**
 * The subagents a session has out right now, keyed by the session that sent them. Their
 * transcripts live one level below the session's own, in
 * `<project>/<sessionId>/subagents/agent-<id>.jsonl`.
 *
 * Only sessions with a live process are walked. Every other session on disk has subagent
 * transcripts too, and all of that work would be thrown away: an errand cannot outlive the
 * process running it.
 */
async function scanSubagents(livePending) {
  const byParent = new Map()
  const live = await livePending
  if (!live.size) return byParent
  const seen = new Set()
  const cutoff = Date.now() - SUBAGENT_WINDOW_MS
  for (const projectDir of await listDirs(CLI_PROJECTS)) {
    for (const sessionDir of await listDirs(projectDir)) {
      const parent = path.basename(sessionDir)
      if (!live.has(parent)) continue
      const dir = path.join(sessionDir, 'subagents')
      for (const file of await listFiles(dir, (n) => n.endsWith('.jsonl'))) {
        const stat = await fsp.stat(file).catch(() => null)
        if (!stat || stat.mtimeMs < cutoff) continue
        // A subagent that has handed its answer back is finished however recently it wrote —
        // the same question `awaitingReply` asks of a thread, put to the errand's own transcript.
        seen.add(file)
        if (await awaitingReply(file)) continue
        const out = byParent.get(parent) || []
        out.push({
          id: path.basename(file, '.jsonl'),
          task: await subagentTask(file, stat.mtimeMs),
          lastActivityAt: stat.mtimeMs,
        })
        byParent.set(parent, out)
      }
    }
  }
  // Errands are many and short-lived, so the cache is pruned to what this pass actually saw
  // rather than growing for the life of the process the way the thread cache can afford to.
  for (const file of subagentCache.keys()) {
    if (!seen.has(file)) subagentCache.delete(file)
  }
  return byParent
}

/**
 * What deleting a thread in the desktop app leaves behind, in the folder its record was in:
 * `deleted_<cliSessionId>`, holding the deletion time in epoch ms. The record goes; the CLI
 * transcript does not. Without the marker that transcript is indistinguishable from a thread
 * started in a terminal, so a thread you had got rid of walked straight back onto the map as one.
 */
const DELETED_MARKER = /^deleted_(.+)$/
const isRecord = (name) => name.startsWith('local_') && name.endsWith('.json')

/**
 * The fields of a desktop record the scan actually reads. A record is not small: the app
 * writes its whole MCP connector configuration into each one (`remoteMcpServersConfig`, close
 * to a megabyte on a machine with a dozen connectors), and on this machine the store came to
 * 148 MB over 204 records — read and parsed in full on every 15-second poll, for perhaps
 * 60 KB of fields anyone looks at. Half of every scan, and most of the process's memory.
 * Keeping only these means the cache below holds kilobytes, not the store.
 */
function pickRecord(r) {
  return {
    sessionId: r.sessionId,
    cliSessionId: r.cliSessionId,
    cwd: r.cwd,
    originCwd: r.originCwd,
    title: r.title,
    bridgeSessionIds: r.bridgeSessionIds,
    model: r.model,
    effort: r.effort,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    lastFocusedAt: r.lastFocusedAt,
    error: r.error,
    isStarred: r.isStarred,
    scheduledTaskId: r.scheduledTaskId,
    prState: r.prState,
    isArchived: r.isArchived,
  }
}

/**
 * Parsed records, keyed by file and pinned to the mtime they were read at — the same shape
 * `metaCache` already gives transcripts. A steady-state poll is then 204 stats and no reads.
 */
const recordCache = new Map()

/** Every thread the desktop app has a record for, and the ids of the ones it has deleted. */
async function scanDesktopSessions() {
  const records = []
  const deleted = new Set()
  const seen = new Set()
  const accounts = (await Promise.all(DESKTOP_STORES.map((store) => listDirs(store)))).flat()
  for (const account of accounts) {
    for (const org of await listDirs(account)) {
      for (const file of await listFiles(org, (n) => isRecord(n) || DELETED_MARKER.test(n))) {
        const marker = DELETED_MARKER.exec(path.basename(file))
        if (marker) {
          // Only the name is read. When it was deleted is not something the map shows.
          if (isCliId(marker[1])) deleted.add(marker[1])
          continue
        }
        seen.add(file)
        let stat
        try {
          stat = await fsp.stat(file)
        } catch {
          continue
        }
        const cached = recordCache.get(file)
        if (cached && cached.mtime === stat.mtimeMs) {
          records.push(cached.record)
          continue
        }
        try {
          const record = pickRecord(JSON.parse(await fsp.readFile(file, 'utf8')))
          recordCache.set(file, { mtime: stat.mtimeMs, record })
          records.push(record)
        } catch {
          // A session mid-write. The previous read is still the best account of this thread —
          // without it the thread blinks off the map for a poll every time the app saves.
          if (cached) records.push(cached.record)
        }
      }
    }
  }
  // A record the app has since removed must not live on in here.
  for (const file of recordCache.keys()) if (!seen.has(file)) recordCache.delete(file)
  return { records, deleted }
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
    desktopSessionId, desktopSessionIds, cliSessionId, bridgeSessionId,
    titled, hasLiveProcess, transcriptFile, recordActivityAt, ...rest
  } = t
  return {
    ...rest,
    canOpen: isDesktopId(desktopSessionId) || isCliId(cliSessionId),
    // The cwd rides along because resuming from a terminal has to happen in the folder the
    // session ran in — the worktree, not the repo root.
    ref: { desktopSessionId, desktopSessionIds, cliSessionId, cwd: t.cwd || '' },
  }
}

async function scanThreads() {
  // The subagent walk needs the live set, and waiting for it here would serialise scans the
  // README says must never block — so it is handed the promise and waits on it itself.
  const livePending = scanLiveSessions()
  const [{ records: desktop, deleted }, transcripts, live, subagents] = await Promise.all([
    scanDesktopSessions(),
    scanTranscripts(),
    livePending,
    scanSubagents(livePending),
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
      id: ID(cliSessionId || s.sessionId),
      cliSessionId,
      desktopSessionId: s.sessionId || '',
      desktopSessionIds: s.sessionId ? [s.sessionId] : [],
      titled: Boolean(s.title),
      bridgeSessionId: (s.bridgeSessionIds && s.bridgeSessionIds[0]) || '',
      title: s.title || meta?.customTitle || meta?.aiTitle || meta?.summary || meta?.promptTitle || 'Untitled thread',
      preview: meta?.firstPrompt ? meta.firstPrompt.slice(0, 240) : '',
      project,
      projectPath,
      worktree,
      cwd,
      gitBranch: meta?.gitBranch || '',
      model: s.model || '',
      effort: s.effort || '',
      createdAt: num(s.createdAt) || meta?.startedAt || 0,
      // The desktop record's own stamp lags: the app writes it when the thread is focused, so a
      // session running in a terminal — or in a window you are not looking at — reads as hours
      // old while its transcript is being written to right now. The later of the two is true.
      lastActivityAt: Math.max(
        num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
        entry?.mtime || 0
      ),
      // Kept apart from the above. "Unread" compares against when you last *looked*, and both
      // sides have to come from the app's own bookkeeping: measure a transcript mtime against
      // `lastFocusedAt` instead and every background write puts a `?` over half the colony.
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

  // Transcripts with no desktop record — threads started straight from the terminal, and threads
  // the app has since deleted.
  for (const [id, entry] of transcripts) {
    if (claimed.has(id)) continue
    const meta = await transcriptMeta(entry)
    const cwd = meta.cwd || decodeProjectDir(path.basename(entry.projectDir))
    const { projectPath, project, worktree } = projectOf(cwd, '')
    add({
      id: ID(id),
      cliSessionId: id,
      desktopSessionId: '',
      desktopSessionIds: [],
      titled: Boolean(meta.customTitle || meta.aiTitle),
      bridgeSessionId: '',
      title: meta.customTitle || meta.aiTitle || meta.summary || meta.promptTitle || 'Untitled thread',
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
      // Deleted in the app, and reported the way an archive made there is. `archived` is the
      // read-only field an adapter has for "gone from the harness's own UI", and the colony sends
      // the astronaut home for it exactly as it does for an archive of its own — rather than the
      // thread simply vanishing from one scan to the next. Only a transcript with no record left
      // qualifies: resuming a deleted thread makes the app write a fresh record while the marker
      // stays behind, and a record that exists is the newer truth.
      archived: deleted.has(id),
      hasTranscript: true,
      sizeBytes: entry.size,
      transcriptFile: entry?.file || '',
      source: 'cli',
    })
  }

  const now = Date.now()

  /**
   * Drop the app's empty bookkeeping records.
   *
   * Resuming a thread makes the desktop app write a second record for the same conversation, and
   * one of the two carries the title and the transcript link while the other carries nothing.
   * With no `cliSessionId` on the empty one there is no key to merge the pair on, so it survives
   * as a thread of its own: an untitled entry with no transcript behind it, standing on the map
   * as a nameless twin of a thread you have already dealt with.
   *
   * A record with no transcript, no title and no live process is not a conversation. The age
   * check keeps a genuinely new session — opened seconds ago, nothing written yet — out of it.
   */
  const NEW_SESSION_MS = 10 * 60 * 1000
  const threads = [...byId.values()].filter(
    (t) =>
      t.hasTranscript ||
      t.titled ||
      t.hasLiveProcess ||
      now - (t.lastActivityAt || t.createdAt || 0) < NEW_SESSION_MS
  )

  // Unread = the thread moved on after you last looked at it; never opened counts as unread.
  // Terminal-only threads have no focus history at all, so "unread" is unknowable — not true.
  for (const thread of threads) {
    const seenAt = thread.recordActivityAt ?? thread.lastActivityAt
    thread.unread = thread.desktopSessionIds.length > 0 && seenAt > thread.lastFocusedAt
    const fresh = now - thread.lastActivityAt < ACTIVE_WINDOW_MS
    const waiting =
      thread.hasLiveProcess && fresh && thread.transcriptFile ? await awaitingReply(thread.transcriptFile) : false
    thread.running = thread.hasLiveProcess && fresh && !waiting
    // A thread that handed the turn back wants you, whether or not the desktop app has ever seen
    // it — the only way a terminal-only thread can ask for anything at all.
    if (waiting) thread.unread = true
    const errands = subagents.get(thread.cliSessionId)
    if (errands) thread.subagents = errands
  }
  return threads.map(toThread)
}

/**
 * Where the `claude` CLI is, for a machine that has it but no desktop app to answer the deep
 * link, or a page that would rather have a terminal. PATH first, then the places its installers
 * put it — never inside an application bundle.
 */
const CLI_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.claude', 'local'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
]
const cliBinary = () => findExecutable('claude', CLI_DIRS)

/**
 * The pid of the live CLI process behind a session, if any. Same registry and same caveat as
 * `scanLiveSessions`: files outlive their pids, so the pid is probed before it counts.
 */
async function liveSessionPid(sessionId) {
  for (const file of await listFiles(CLI_LIVE, (n) => n.endsWith('.json'))) {
    let record
    try {
      record = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (record.sessionId !== sessionId || !record.pid) continue
    try {
      process.kill(record.pid, 0)
      return record.pid
    } catch {
      /* process is gone */
    }
  }
  return 0
}

/**
 * Hands the thread back to Claude Code. `epitaxy/<local_…>` *navigates* the desktop app
 * to a thread it already has; `resume` *imports* the transcript, which spawns a second
 * untitled session and rewrites the .jsonl — so it is only ever the fallback for threads
 * the app has never seen. Ids are pattern-checked before they reach the opener.
 *
 * A terminal-started thread that is still running gets its live pid handed along too: it
 * already has a window somewhere on this machine, and fronting that window is a better answer
 * than `resume` importing the transcript into the desktop app as a second, untitled session.
 * Whether and how to front it is the server's call — see `server/lib/windows.mjs`.
 */
async function openThread(ref) {
  const { desktopSessionId, cliSessionId, cwd } = ref || {}
  let url = ''
  if (isDesktopId(desktopSessionId)) url = `claude://claude.ai/epitaxy/${desktopSessionId}`
  else if (isCliId(cliSessionId)) url = `claude://resume?session=${cliSessionId}`

  // Only threads the desktop app has never seen: for the rest the deep link navigates to the
  // tab the app already has, which is exactly the right window to front.
  let pid = 0
  if (!isDesktopId(desktopSessionId) && isCliId(cliSessionId)) pid = await liveSessionPid(cliSessionId)

  let command
  if (isCliId(cliSessionId)) {
    const bin = await cliBinary()
    if (bin) command = { argv: [bin, '--resume', cliSessionId], cwd: typeof cwd === 'string' ? cwd : '' }
  }

  if (!url && !command) return { ok: false, error: 'No openable session id on that thread' }
  return { ok: true, url, command, pid }
}

/**
 * A brand new thread rooted in a repo — the same `code/new?folder=` deep link Finder's
 * "New Claude Code Session Here" quick action uses. Nothing is resumed and nothing is
 * written: the desktop app just opens an empty session with that folder as its workspace.
 */
async function newSession(dir) {
  // The Scratch plot's folder holds the desktop app's own scratch sessions. A session opened on
  // it, or the CLI run in it, would work inside the app's data rather than in a repo of yours.
  if (SCRATCH_ROOT.test(dir)) {
    return { ok: false, error: 'Scratch threads have no folder of their own; start one in the Claude app' }
  }

  const url = `claude://code/new?${new URLSearchParams({ folder: dir })}`
  const bin = await cliBinary()
  const command = bin ? { argv: [bin], cwd: dir } : undefined
  return { ok: true, url, command }
}

export default {
  id: 'claude-code',
  name: 'Claude Code',
  /** Only claim this machine if one of the two stores is actually there. */
  detect: async () => (await Promise.all(DESKTOP_STORES.map(exists))).some(Boolean) || (await exists(CLI_PROJECTS)),
  scanThreads,
  openThread,
  newSession,
  paths: { DESKTOP_STORES, CLI_PROJECTS, CLI_LIVE },
}
