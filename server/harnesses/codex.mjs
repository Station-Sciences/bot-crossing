/**
 * Harness adapter: Codex (OpenAI) — the CLI, the IDE extension, and the app, together.
 *
 * Everything that knows the shape of Codex's own files lives in this one module. The
 * contract it implements is written down in `server/harnesses/README.md`.
 *
 * One store, unlike Claude Code: Codex keeps a single append-only transcript per thread at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`, whatever started it. Every
 * record is `{ timestamp, type, payload }`, and the two ends of the file answer different
 * questions — the head says what this thread *is*, the tail says what it is *doing*. So the
 * scan reads both ends and never the middle, which is where the megabytes are.
 *
 * Alongside it, `$CODEX_HOME/session_index.jsonl` maps a session id to the human-readable
 * name Codex shows in its own picker. That is the title; the transcript is everything else.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, listFiles, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/** Codex honours `CODEX_HOME`; everything below hangs off it so a relocated home still works. */
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex')
/** One transcript per thread, filed by the date it started. */
const SESSIONS = path.join(CODEX_HOME, 'sessions')
/** `{ id, thread_name, updated_at }` per thread — where the titles come from. */
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl')

/**
 * How much of each end of a transcript to read.
 *
 * The head has to clear Codex's preamble — the base instructions and the skills block run to
 * tens of kilobytes before the first prompt — and then reach the prompt itself. Measured
 * across a real `~/.codex`, the first user record landed by 46KB in every transcript, so
 * 192KB is generous rather than tuned. The tail only has to cover the last few turns.
 */
const HEAD_BYTES = 192 * 1024
const TAIL_BYTES = 64 * 1024

/**
 * How recently an open turn must have written something to still count as running.
 *
 * A turn in flight is an unmatched `task_started` at the end of the transcript. That is a
 * reliable signal right up until Codex exits without closing the turn — a crash, a killed
 * terminal — after which the dangling `task_started` would say "working" forever. Ten
 * minutes is long enough to sit through a slow tool call, which writes nothing while it
 * runs, and short enough that a dead session stops hammering within one coffee.
 */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000

/** `rollout-2026-08-26T20-17-57-01a03d25-….jsonl` — the id is the tail of the name. */
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** Ids are namespaced: Codex and Claude Code both hand out bare UUIDs. */
const idOf = (sessionId) => `codex:${sessionId}`

const ts = (v) => {
  const t = Date.parse(v || '')
  return Number.isNaN(t) ? 0 : t
}

/**
 * Reduce a turn's input to the part the person actually typed.
 *
 * Two layers of wrapper get in the way. Codex brackets the turn in `<environment_context>`
 * and friends, and the IDE extension prepends the paths of any attached files above the
 * prompt, marking where the real text starts with a `## My request:` heading.
 */
function cleanPrompt(s) {
  let text = String(s).replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
  const request = /^##[ \t]*My request[^\n:]*:[ \t]*$/im.exec(text)
  if (request) text = text.slice(request.index + request[0].length)
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The user-typed text of a record, if it has any.
 *
 * Both shapes matter. A live turn is logged as `event_msg/user_message`; a *resumed* thread
 * replays its history first, where the same prompt reappears as `response_item/message` with
 * `role: user`. Taking either is what makes `preview` the thread's original first prompt
 * rather than whatever restarted it.
 */
function userText(payload) {
  if (payload.type === 'user_message') return payload.message || ''
  if (payload.type === 'message' && payload.role === 'user') {
    for (const part of payload.content || []) {
      if (part && typeof part.text === 'string') return part.text
    }
  }
  return ''
}

/** A prompt is only a prompt once the wrapper blocks are gone. */
const promptFrom = (raw) => (raw && !raw.trimStart().startsWith('<') ? cleanPrompt(raw) : '')

/**
 * Rescue a prompt from the partial record a fixed-size head read leaves behind.
 *
 * Codex logs a pasted file or a long spec as one enormous record — approaching a megabyte in
 * real transcripts. Such a record routinely *starts* inside the head and runs past the end of
 * it, so `jsonLines` drops it and the thread loses its preview. Since only the first couple
 * of hundred characters are ever shown, this walks the truncated JSON string by hand, minds
 * the backslash escapes, and stops well before the cut. Nothing else parses partial records:
 * it is worth it here because it is the difference between a card with a preview and a card
 * without one, on roughly a quarter of real threads.
 */
function salvagePrompt(partial) {
  const at = /"(?:message|text)"\s*:\s*"/.exec(partial)
  if (!at) return ''
  let i = at.index + at[0].length
  let out = ''
  while (i < partial.length && out.length < 600) {
    const c = partial[i]
    if (c === '\\') {
      out += partial.slice(i, i + 2)
      i += 2
      continue
    }
    if (c === '"') break
    out += c
    i += 1
  }
  // A cut can land mid-escape, which would make the rewrapped string unparseable.
  out = out.replace(/\\+$/, '')
  try {
    return JSON.parse(`"${out}"`)
  } catch {
    return ''
  }
}

/**
 * What the head of a transcript says the thread is: where it runs, what model, first prompt.
 *
 * `turn_context` repeats per turn and is read for the earliest known model; the tail supplies
 * a newer one if the thread has since switched.
 */
function readHeadMeta(text) {
  const meta = { sessionId: '', createdAt: 0, cwd: '', model: '', effort: '', source: '', prompt: '' }
  const cut = text.lastIndexOf('\n') + 1

  for (const r of jsonLines(text.slice(0, cut))) {
    const p = r.payload
    if (!p || typeof p !== 'object') continue

    if (r.type === 'session_meta') {
      meta.sessionId = meta.sessionId || p.session_id || p.id || ''
      meta.createdAt = meta.createdAt || ts(p.timestamp) || ts(r.timestamp)
      meta.cwd = meta.cwd || p.cwd || ''
      meta.source = meta.source || p.source || p.originator || ''
    } else if (r.type === 'turn_context') {
      meta.cwd = meta.cwd || p.cwd || (p.workspace_roots && p.workspace_roots[0]) || ''
      meta.model = meta.model || p.model || ''
      meta.effort = meta.effort || p.collaboration_mode?.settings?.reasoning_effort || ''
    } else if (!meta.prompt) {
      meta.prompt = promptFrom(userText(p))
    }
  }

  if (!meta.prompt) meta.prompt = promptFrom(salvagePrompt(text.slice(cut)))
  return meta
}

/**
 * What the tail says the thread is doing: whether a turn is open, and how it last went.
 *
 * Turn lifecycle is `task_started` … `task_complete` | `turn_aborted`, so an unmatched
 * `task_started` at the end means Codex is mid-turn. An abort is only an error when it was
 * not the user's doing — `reason: 'interrupted'` is somebody pressing escape, which is a
 * finished thread rather than a broken one.
 */
function readTailMeta(text) {
  const meta = { openTurn: false, hasError: false, model: '', effort: '', lastEventAt: 0 }
  for (const r of jsonLines(text)) {
    const p = r.payload
    if (!p || typeof p !== 'object') continue
    meta.lastEventAt = ts(r.timestamp) || meta.lastEventAt

    if (r.type === 'turn_context') {
      meta.model = p.model || meta.model
      meta.effort = p.collaboration_mode?.settings?.reasoning_effort || meta.effort
      continue
    }
    switch (p.type) {
      case 'task_started':
        meta.openTurn = true
        meta.hasError = false // a new turn supersedes however the last one ended
        break
      case 'task_complete':
        meta.openTurn = false
        break
      case 'turn_aborted':
        meta.openTurn = false
        if (p.reason && p.reason !== 'interrupted') meta.hasError = true
        break
      case 'error':
      case 'stream_error':
        meta.hasError = true
        break
    }
  }
  return meta
}

/** Both ends of a transcript are expensive to parse, so keep them until the file changes. */
const metaCache = new Map()
async function transcriptMeta(entry) {
  const cached = metaCache.get(entry.file)
  if (cached && cached.mtime === entry.mtime) return cached.meta

  let meta
  try {
    const [head, tail] = await Promise.all([
      readHead(entry.file, HEAD_BYTES, { keepPartial: true }),
      entry.size > HEAD_BYTES ? readTail(entry.file, TAIL_BYTES) : Promise.resolve(''),
    ])
    // A transcript smaller than one head read is already entirely in `head`.
    meta = { ...readHeadMeta(head), tail: readTailMeta(tail || head) }
  } catch {
    meta = { ...readHeadMeta(''), tail: readTailMeta('') }
  }
  metaCache.set(entry.file, { mtime: entry.mtime, meta })
  return meta
}

/**
 * Every transcript on disk. The tree is `sessions/YYYY/MM/DD/`, walked by shape rather than
 * by globbing so that a stray file or a folder Codex adds later costs nothing.
 */
async function scanTranscripts() {
  const out = []
  const numeric = (dir) => /^\d+$/.test(path.basename(dir))

  for (const year of (await listDirs(SESSIONS)).filter(numeric)) {
    for (const month of (await listDirs(year)).filter(numeric)) {
      for (const day of (await listDirs(month)).filter(numeric)) {
        for (const file of await listFiles(day, (n) => ROLLOUT.test(n))) {
          const sessionId = ROLLOUT.exec(path.basename(file))[1].toLowerCase()
          try {
            const stat = await fsp.stat(file)
            out.push({ sessionId, file, size: stat.size, mtime: stat.mtimeMs })
          } catch {
            /* rotated away mid-scan — skip */
          }
        }
      }
    }
  }
  return out
}

/**
 * Titles, keyed by session id. This is the name Codex shows in its own thread picker, so it
 * is the one a person will recognise. The file is a log rather than a table — a thread
 * renamed twice appears twice — so later lines win.
 */
async function readTitles() {
  const titles = new Map()
  try {
    const text = await readHead(SESSION_INDEX, 1024 * 1024)
    for (const r of jsonLines(text)) {
      if (!r.id || !r.thread_name) continue
      titles.set(String(r.id).toLowerCase(), { name: r.thread_name, at: ts(r.updated_at) })
    }
  } catch {
    /* no index yet — every thread falls back to its first prompt */
  }
  return titles
}

/**
 * The branch a working directory is on, straight out of `.git/HEAD`.
 *
 * Codex records no branch of its own, and shelling out to `git` once per thread would break
 * the "never block the scan" rule. Reading the one file git keeps the answer in does not:
 * it is a few dozen bytes, it is cached against its own mtime, and it costs one read per
 * distinct repo rather than one per thread.
 *
 * A linked worktree has `.git` as a *file* pointing at
 * `…/.git/worktrees/<name>`, which is also where the worktree's name comes from.
 */
const gitCache = new Map()
async function readGit(cwd) {
  if (!cwd) return { gitBranch: '', worktree: '', root: '' }

  const dotgit = path.join(cwd, '.git')
  let stat
  try {
    stat = await fsp.stat(dotgit)
  } catch {
    return { gitBranch: '', worktree: '', root: '' } // not a repo, or gone from this machine
  }

  const cached = gitCache.get(dotgit)
  if (cached && cached.mtime === stat.mtimeMs) return cached.git

  const git = { gitBranch: '', worktree: '', root: '' }
  try {
    let gitDir = dotgit
    if (stat.isFile()) {
      const pointer = /gitdir:\s*(.+)/.exec(await fsp.readFile(dotgit, 'utf8'))
      if (pointer) {
        gitDir = path.resolve(cwd, pointer[1].trim())
        const linked = /[\\/]\.git[\\/]worktrees[\\/]([^\\/]+)$/.exec(gitDir)
        if (linked) {
          git.worktree = linked[1]
          git.root = gitDir.slice(0, linked.index)
        }
      }
    }
    const head = (await readHead(path.join(gitDir, 'HEAD'), 512)).trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    // Detached HEAD is a commit sha, which is not a branch name and not worth showing.
    git.gitBranch = ref ? ref[1] : ''
  } catch {
    /* mid-rebase, or a .git we cannot read — no branch is a fine answer */
  }

  gitCache.set(dotgit, { mtime: stat.mtimeMs, git })
  return git
}

async function scanThreads() {
  const [entries, titles] = await Promise.all([scanTranscripts(), readTitles()])
  const now = Date.now()

  return Promise.all(
    entries.map(async (entry) => {
      const meta = await transcriptMeta(entry)
      const sessionId = meta.sessionId || entry.sessionId
      const title = titles.get(sessionId.toLowerCase())
      const cwd = meta.cwd || ''
      const { gitBranch, worktree, root } = await readGit(cwd)
      const projectPath = root || cwd
      // The index's own clock counts: renaming a thread touches it without touching the file.
      const lastActivityAt = Math.max(entry.mtime, meta.tail.lastEventAt, title?.at || 0)

      return {
        id: idOf(sessionId),
        title: title?.name || meta.prompt.slice(0, 80) || 'Untitled thread',
        preview: meta.prompt.slice(0, 240),
        project: path.basename(projectPath) || projectPath || 'unknown',
        projectPath,
        worktree,
        cwd,
        gitBranch,
        model: meta.tail.model || meta.model || '',
        effort: meta.tail.effort || meta.effort || '',
        createdAt: meta.createdAt || entry.mtime,
        lastActivityAt,
        // Codex records nothing about when you last *looked* at a thread, so "moved on since
        // you last read it" is unknowable here rather than false. Same call the Claude Code
        // adapter makes for terminal-only threads.
        lastFocusedAt: 0,
        unread: false,
        // Against the file's own mtime rather than `lastActivityAt`: the question is
        // strictly "was this transcript appended to recently", and `lastActivityAt`
        // also folds in the index's clock, so a rename would resurrect a dead turn.
        running: meta.tail.openTurn && now - entry.mtime < ACTIVE_WINDOW_MS,
        hasError: meta.tail.hasError,
        starred: false,
        routine: '',
        prState: '',
        // Codex has no archive of its own, so this is always false and the colony's own
        // archive list is the only one. See `setArchived`.
        archived: false,
        sizeBytes: entry.size,
        source: meta.source || 'cli',
        // No `codex://` scheme is registered on any platform, so there is nothing to hand the
        // OS opener. Saying so up front greys the button out rather than failing on click.
        canOpen: false,
        canArchive: false,
        ref: { sessionId, file: entry.file, cwd },
      }
    })
  )
}

/**
 * Codex registers no URL scheme, so there is no deep link to hand back — the honest answer
 * is to say so and tell the user the command that does the job. `canOpen: false` above means
 * the UI has already greyed the button out; this is the backstop if it is called anyway.
 */
function openThread(ref) {
  const where = ref?.cwd ? ` in ${ref.cwd}` : ''
  return {
    ok: false,
    error: ref?.sessionId
      ? `Codex has no deep link. Run \`codex resume ${ref.sessionId}\`${where}`
      : 'Codex has no deep link for that thread',
  }
}

/** Same again: starting a Codex session is `codex` in the folder, not a URL. */
function newSession(dir) {
  return { ok: false, error: `Codex has no new-session deep link. Run \`codex\` in ${dir}` }
}

/**
 * Codex has no archived state in its own records — no flag in the transcript, none in the
 * session index — and inventing one by writing to files it owns is not worth it for a
 * viewer. Declining leaves the colony's own archive list in charge: the thread still goes
 * away here and the astronaut still walks back to the ship.
 */
function setArchived() {
  return { ok: false, error: 'Codex has no archived state of its own — archived in the colony only' }
}

export default {
  id: 'codex',
  name: 'Codex',
  detect: async () => (await exists(SESSIONS)) || (await exists(SESSION_INDEX)),
  scanThreads,
  openThread,
  newSession,
  setArchived,
  // No `appStartedAt`: nothing is ever written to Codex's files, so there is no flag for a
  // long-lived app to stomp and nothing for the pending state to wait on.
  paths: { CODEX_HOME, SESSIONS, SESSION_INDEX },
}
