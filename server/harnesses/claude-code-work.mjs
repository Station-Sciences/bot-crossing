/**
 * The rest of what Claude Code leaves on disk. Read by `claude-code.mjs`, and by nothing else.
 *
 * Not a harness. `index.mjs` does not list it and it implements none of the adapter interface;
 * it is here rather than in `server/lib/` because every path and every file shape below is
 * Claude Code's own, and the contract in `README.md` asks for that knowledge to stay inside the
 * adapter it belongs to.
 *
 * The adapter already reads the two stores that say a thread *exists*. These are the three that
 * say what it is doing right now:
 *
 *   <temp>/claude/<project>/<session>/tasks/<id>.output
 *       One file per background shell and per monitor the session has opened, named by the id
 *       Claude Code hands back (`b8jqv146x`), holding that call's output as it arrives. Nothing
 *       ever cleans the directory up, so a session open since yesterday still has all 70 of
 *       them, and which ones to draw is decided by the transcript rather than by the listing.
 *
 *   ~/.claude/tasks/<session>/<n>.json
 *       The session's task list, one file per item, with real `blocks`/`blockedBy` edges. Actual
 *       progress through a piece of work, where `sizeBytes` is only a proxy for it.
 *
 *   ~/.claude/jobs/<short>/state.json  +  ~/.claude/daemon/roster.json
 *       Sessions running headless under the background daemon. They write a transcript in the
 *       ordinary place, so the colony already draws them. They never write a
 *       `~/.claude/sessions` file, so the pid probe finds nothing and every one of them is drawn
 *       as idle while it works.
 *
 * All three are undocumented and none is stable, so the rules are the adapter's rules: every
 * field optional, every unknown value read as information rather than as an error, every read
 * capped, and a shape nobody recognises skipped rather than thrown over.
 *
 * Read-only, like everything else here. Nothing in this file opens a file for writing.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { listDirs, listFiles, num, readTail } from '../lib/fsutil.mjs'

/**
 * How much of a task's output is read to find its last line and its exit trailer. A build log
 * runs to megabytes and only the end of it says anything about what the call is doing now.
 */
const TASK_TAIL_BYTES = 8 * 1024

/** What a card can show of one line, matching the cut the adapter puts on a prompt. */
const DETAIL_CHARS = 120

/**
 * How long a task's output may sit untouched before the call behind it is presumed over.
 *
 * A backstop, not the answer: see `taskLive`. It only decides the case the other two signals
 * cannot: a shell killed outright, or one whose trailer never landed because the session it
 * belonged to was interrupted. Generous on purpose, because a compile or a test run is silent
 * for minutes at a time and a bot that blinks out mid-build is worse than one that lingers.
 */
const TASK_IDLE_MS = 15 * 60 * 1000

/**
 * The trailer a detached shell writes when it ends: `[exited with code 0]`, or
 * `[process exited while detached; exit code unknown]` when it was never reaped. Seen on 32 of
 * 70 task files in one real session; the other 38 were still running, or were killed without
 * one, which is why this is a signal and not the whole test.
 */
const EXIT_TRAILER = /\[(?:exited with code -?\d+|process exited[^\]]*)\]\s*$/

/** First line only, cut to fit, with a marker for what was cut. */
export function oneLine(text, max = DETAIL_CHARS) {
  let s = String(text ?? '')
  const nl = s.search(/[\r\n]/)
  let cut = false
  if (nl !== -1) {
    s = s.slice(0, nl)
    cut = true
  }
  if (s.length > max) {
    // Back off to a whole codepoint. A prompt is typed by a person and can carry anything, and
    // half a surrogate pair reaches the page as a replacement character.
    let end = max
    if (end > 0 && s.codePointAt(end - 1) > 0xffff) end -= 1
    s = s.slice(0, end)
    cut = true
  }
  s = s.trimEnd()
  return cut && s ? `${s} …` : s
}

/**
 * What a tool call is about, in one line: the command for a shell, the path for an edit, the
 * pattern for a search. Falls through to `description`, which most of the rest carry, and then
 * to the first string in the input, so a tool nobody here has heard of still says something
 * rather than nothing, which is the point of not enumerating them.
 */
export function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return ''
  let s = ''
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      s = input.command
      break
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      s = input.file_path
      break
    case 'NotebookEdit':
      s = input.notebook_path
      break
    case 'Grep':
    case 'Glob':
      s = input.pattern
      if (s && input.path) s = `${s} in ${input.path}`
      break
    case 'WebFetch':
    case 'WebSearch':
      s = input.url || input.query
      break
    case 'Task':
    case 'Agent':
      s = input.description || input.prompt
      break
    default:
      break
  }
  if (!s) s = input.description
  if (!s) {
    for (const value of Object.values(input)) {
      if (typeof value === 'string' && value) {
        s = value
        break
      }
    }
  }
  return oneLine(s)
}

// ── background shells and monitors ────────────────────────────────────────────

/**
 * Whether a background call is still going, and the honest limits of saying so from disk.
 *
 * Three signals, in order of how much they actually know:
 *
 * 1. **The exit trailer.** Exact when it is there. A file ending in `[exited with code 1]` is
 *    over, whatever its mtime says.
 * 2. **A monitor's own deadline.** A monitor never holds its output file open and writes nothing
 *    when it stops, so the file it leaves behind is indistinguishable from one still armed. The
 *    only thing on disk that says when it ends is the `timeoutMs` it declared when it started,
 *    which the transcript records. That is an upper bound rather than an observation: a watch
 *    whose source ends early goes on being drawn until its declared timeout runs out.
 * 3. **Staleness**, for everything the first two miss.
 *
 * Holding the file open was the other option and does not survive leaving Windows. An exclusive
 * open answers this exactly there, because a shell holds its output for exactly as long as it
 * runs. POSIX has no mandatory locking, so the same probe on macOS and Linux succeeds
 * against a file that is being written to right now and reports every live shell as finished.
 */
function taskLive(task, now) {
  if (task.exited) return false
  if (task.expiresAt) return now < task.expiresAt
  return now - task.lastOutputAt < TASK_IDLE_MS
}

/**
 * The background calls a session has in flight, given what the transcript says it opened.
 *
 * `named` is the join, keyed by task id. See `readTurn` in `claude-code.mjs`, which builds it
 * from the tail of the transcript. It is what makes this affordable *and* what makes it correct:
 * the directory holds every task the session has ever run, its subagents' and its workflow
 * agents' among them, and not one filename says which is which or what it was for. Listing it
 * would put 70 nameless things on a card. Asking it only about the ids the recent transcript
 * actually named bounds the work to the calls still worth drawing, and gives every one of them
 * the command that opened it.
 */
export async function readTasks(tasksDir, named, now) {
  if (!named.size) return []
  const out = []
  for (const call of named.values()) {
    const file = path.join(tasksDir, `${call.id}.output`)
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      // The transcript named it and the file is not there: an id from a resumed session whose
      // temp directory has since been cleared. Nothing to say about it, so say nothing.
      continue
    }
    const tail = await readTail(file, TASK_TAIL_BYTES).catch(() => '')
    const task = {
      id: call.id,
      kind: call.kind,
      label: call.label,
      // The last thing it said, which is what the call is doing right now. Blank lines skipped:
      // a shell that has just printed a newline has not stopped saying the thing before it.
      tail: oneLine(tail.split('\n').filter((l) => l.trim()).pop() || ''),
      startedAt: call.startedAt,
      expiresAt: call.timeoutMs ? call.startedAt + call.timeoutMs : 0,
      lastOutputAt: stat.mtimeMs,
      exited: EXIT_TRAILER.test(tail.trimEnd()),
    }
    if (taskLive(task, now)) {
      const { exited, ...rest } = task
      out.push(rest)
    }
  }
  return out.sort((a, b) => b.lastOutputAt - a.lastOutputAt)
}

// ── the task list ─────────────────────────────────────────────────────────────

/**
 * A session's own task list: how far through the work it actually is.
 *
 * One file per item, named by its id, carrying `blocks`/`blockedBy` edges between them: a
 * graph rather than a list. Only the counts and the item in progress come back, because the
 * colony has nowhere to draw a dependency graph and a field nothing reads is a field that goes
 * quietly wrong. The edges are on disk if a view for them ever turns up.
 *
 * `activeForm` rather than `subject`: the file carries both, and the whole reason it does is
 * that one of them is written to be read while the work is happening. "Building the core
 * conversion library", not "Core conversion library".
 */
export async function readTodos(dir) {
  const files = await listFiles(dir, (n) => /^\d+\.json$/.test(n))
  if (!files.length) return null
  let total = 0
  let done = 0
  let active = ''
  // By id rather than by readdir order, so "the first one in progress" means the same thing on
  // every pass: `10.json` sorts before `2.json` as a string, and the item a card names would
  // change from poll to poll for no reason the person can see.
  files.sort((a, b) => num(path.basename(a, '.json')) - num(path.basename(b, '.json')))
  for (const file of files) {
    let item
    try {
      item = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      continue // written while we read it, so skip this one and keep the pass
    }
    total += 1
    if (item.status === 'completed') done += 1
    else if (item.status === 'in_progress' && !active) active = oneLine(item.activeForm || item.subject || '')
  }
  return total ? { total, done, active } : null
}

// ── sessions running under the background daemon ──────────────────────────────

/**
 * Which sessions are alive under the background daemon, as a Set of session ids.
 *
 * These are threads in exactly the sense a terminal one is, with a pid, a cwd and a transcript
 * in the ordinary place, and the colony already draws every one of them. It just draws them
 * asleep:
 * a daemon worker writes no `~/.claude/sessions` file, so the pid probe that decides `running`
 * finds nothing and a job that has been working for an hour sits there as a thread last touched
 * an hour ago.
 *
 * The roster answers it rather than the job's own `state.json`, for the same reason the session
 * registry is probed rather than trusted: a job directory is kept for ever, and its state file
 * is only as current as the last thing written to it. The roster is the supervisor's live book,
 * and its pids are checked here exactly as the registry's are.
 */
export async function readDaemonSessions(rosterFile) {
  const live = new Set()
  let roster
  try {
    roster = JSON.parse(await fsp.readFile(rosterFile, 'utf8'))
  } catch {
    return live // no daemon on this machine, or it is mid-write
  }
  for (const worker of Object.values(roster?.workers || {})) {
    if (!worker?.sessionId || !worker.pid) continue
    try {
      process.kill(worker.pid, 0) // signal 0 only tests for existence
      live.add(worker.sessionId)
    } catch {
      /* the worker has exited and the roster has not caught up */
    }
  }
  return live
}

/**
 * What each daemon job is up to, keyed by session id: its name and its rolling one-line
 * activity. The job's own bookkeeping, which is the only place either appears, because a
 * headless session has no window and no title anywhere else.
 *
 * Every job directory is read, not only the live ones. A job that finished ten minutes ago
 * still has a thread on the map, and "dashboard deployed, server running on 4317" is worth
 * showing on it.
 */
export async function readDaemonJobs(jobsDir) {
  const byId = new Map()
  for (const dir of await listDirs(jobsDir)) {
    let state
    try {
      state = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'))
    } catch {
      continue
    }
    if (!state?.sessionId) continue
    byId.set(state.sessionId, {
      name: oneLine(state.name || ''),
      state: typeof state.state === 'string' ? state.state : '',
      detail: oneLine(state.detail || ''),
    })
  }
  return byId
}
