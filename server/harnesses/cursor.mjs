/**
 * Harness adapter: Cursor (`cursor-agent`).
 *
 * Cursor keeps two completely different stores and this adapter reads one of them.
 *
 *   - **`cursor-agent`**, the CLI, appends a plain JSONL transcript per thread. That is what
 *     is read here, and it is the same shape of problem the Claude Code adapter already
 *     solves for its own CLI half: a directory named after the working directory, a file
 *     named after the session, and nothing else.
 *   - **The IDE's chats** live in `state.vscdb`, a SQLite database the editor holds open and
 *     which runs to tens of gigabytes on a well-used machine. Reading somebody's live
 *     database to draw a picture is not a trade this project makes, so those threads are
 *     not drawn. If Cursor ever writes them out as files, they land here for free.
 *
 * What a Cursor transcript does *not* have is as load-bearing as what it does:
 *
 *   | Missing            | What this adapter does instead                                 |
 *   | ------------------ | -------------------------------------------------------------- |
 *   | any timestamp      | the file's own mtime and birthtime                             |
 *   | a title            | the first user prompt, unwrapped from `<user_query>`           |
 *   | focus history      | `unread` is genuinely unknowable, so it stays `false`          |
 *   | a live-process file| `running` falls back to "written in the last few minutes"       |
 *   | an archived flag   | `setArchived` says so and the colony records it on its own side |
 *
 * That list is the honest cost of the adapter, not a to-do: three of the five are the same
 * concessions `claude-code.mjs` already makes for threads started from a terminal.
 */
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { decodeProjectDir, exists, jsonLines, listDirs, listFiles, readHead } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/**
 * One directory per working directory, each holding an `agent-transcripts/<uuid>/<uuid>.jsonl`.
 * Overridable so the adapter can be pointed at a fixture, and so a Cursor install somewhere
 * other than `$HOME` is reachable without editing this file.
 */
const CURSOR_PROJECTS = process.env.BOT_CROSSING_CURSOR_PROJECTS || path.join(HOME, '.cursor', 'projects')
const TRANSCRIPTS = 'agent-transcripts'

/** The first user prompt is the first record in the file; this is far more than enough. */
const HEAD_BYTES = 128 * 1024
/** `turn_ended` is the last record, so the other end of the file is read separately. */
const TAIL_BYTES = 8 * 1024

/**
 * Cursor writes no live-process file, so "running" has to be inferred from the only thing
 * that moves while an agent works: the transcript itself. The window is deliberately tight.
 * A thread that stopped five minutes ago reads as idle rather than as working, which is the
 * right way round to be wrong — a hammering astronaut over a thread that has finished is a
 * lie the colony tells you every poll, and a quiet one is a lie it tells you once.
 */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Aborting a turn yourself is not the agent being stuck, and `!` means stuck. These are the
 * strings Cursor records when *you* stopped it, and they are deliberately not errors here.
 */
const USER_ABORTS = [/user aborted/i, /user.*interrupted/i, /cancell?ed by user/i]

/** Sessions with no workspace at all. Neither is a folder anybody works in. */
const NOT_A_WORKSPACE = new Set(['empty-window'])

/**
 * The probe backtracks, so its cost grows with the square of the segment count. Real paths
 * are nowhere near this; the cap is a backstop against a pathological name rather than a
 * limit anybody should meet.
 */
const MAX_SEGMENTS = 40

/** Path resolution is a filesystem probe, so it is remembered for the life of the process. */
const pathCache = new Map()
/** Transcript reads are keyed on mtime+size, exactly as the Claude Code adapter keys its own. */
const metaCache = new Map()

/** The last chunk of a file, with a leading partial line dropped so JSON.parse stays safe. */
async function readTail(file, bytes, size) {
  const fh = await fsp.open(file, 'r')
  try {
    const start = Math.max(0, size - bytes)
    const len = Math.min(bytes, size)
    const buf = Buffer.allocUnsafe(len)
    const { bytesRead } = await fh.read(buf, 0, len, start)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
  } finally {
    await fh.close()
  }
}

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Turn `Users-you-Projects-bomac-repo` back into `/Users/you/Projects/bomac-repo`.
 *
 * Cursor flattens a path by replacing every separator with a dash — and it does the same to
 * the dots in a folder called `32northevents.com`, so the encoding is lossy in two different
 * ways at once. A repo whose name legitimately contains a dash is not the exception here: on
 * a real machine 23 of 119 project directories cannot be decoded by splitting on dashes.
 *
 * There is no way to undo that from the string alone, so the string is not what is used. The
 * segments are walked against the filesystem instead, taking the longest run that exists as a
 * directory at each level and backtracking when a branch dead-ends. The disk holds the answer;
 * this just asks it.
 */
async function probePath(base, segments, from) {
  if (from === segments.length) return base

  const entries = await listDirs(base)
  // Longest run first: `bomac-repo` must be found before a match on `bomac` sends the walk
  // down a branch that cannot be finished.
  for (let to = segments.length; to > from; to--) {
    const want = segments.slice(from, to).join('-')
    for (const entry of entries) {
      if (flatten(path.basename(entry)) !== want) continue
      const found = await probePath(entry, segments, to)
      if (found) return found
    }
  }
  return null
}

/**
 * The same flattening Cursor applies, so a real directory name can be compared against a run
 * of encoded segments directly.
 *
 * Guessing which separator produced a given dash does not work: `a-b/c.d-e` needs a slash, a
 * dot and a literal dash inside a single comparison, and enumerating the combinations is
 * exponential in the number of segments. Reading the directory and flattening what is really
 * there is exact, and costs one `readdir` per level instead.
 *
 * Each non-alphanumeric character becomes exactly one dash rather than collapsing a run of
 * them, because the runs carry information: a folder named `-Users` flattens to `-Users`,
 * which is the `--` you see in the encoded name and the only trace of that leading dash.
 */
function flatten(name) {
  return name.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * The workspace a transcript belongs to, recovered from anywhere it can be.
 *
 * The probe above answers for every folder that still exists. A folder that has since been
 * moved or deleted cannot be probed for, so the transcript is asked instead: Cursor records
 * absolute paths in the `input` of every `Read`, `Glob` and `Shell` tool call, and the
 * directory they agree on is the workspace. That fallback is what keeps a repo you have
 * since renamed from vanishing off the map.
 */
async function resolveWorkspace(name, transcript) {
  if (pathCache.has(name)) return pathCache.get(name)

  let resolved = ''
  const naive = decodeProjectDir(name)
  if (await isDir(naive)) {
    resolved = naive
  } else {
    // The probe walks down from the filesystem root the name encodes: `/` here, `C:\\` on
    // Windows, where the drive letter is the first segment and the double dash after it is
    // the colon. Empty segments are kept rather than filtered: a `--` in the encoded name is
    // also how a directory whose own name starts with a dash survives the flattening, and
    // dropping the empty string makes that component impossible to rebuild at any joiner.
    const drive = /^([A-Za-z])--(.*)$/.exec(name)
    const root = drive ? `${drive[1]}:${path.sep}` : '/'
    const segments = (drive ? drive[2] : name).split('-')
    resolved = segments.length <= MAX_SEGMENTS ? (await probePath(root, segments, 0)) || '' : ''
  }
  if (!resolved && transcript) resolved = await workspaceFromTranscript(transcript)
  // Remember the failure too: probing is a lot of stat calls to repeat every poll for a
  // folder that is not coming back.
  pathCache.set(name, resolved)
  return resolved
}

/** The deepest directory every absolute path in a transcript's tool calls sits under. */
async function workspaceFromTranscript(file) {
  let records
  try {
    records = jsonLines(await readHead(file, HEAD_BYTES))
  } catch {
    return ''
  }

  const paths = []
  for (const r of records) {
    for (const part of r?.message?.content || []) {
      if (part?.type !== 'tool_use' || !part.input) continue
      for (const value of Object.values(part.input)) {
        if (typeof value === 'string' && path.isAbsolute(value)) paths.push(value)
      }
    }
  }
  if (!paths.length) return ''

  // Split on either separator and rebuilt on this platform's, with the first path's own
  // root kept: `C:\\` is a root and `/` is a root, and neither is a segment.
  const root = path.parse(paths[0]).root
  const split = paths.map((p) => p.slice(path.parse(p).root.length).split(/[\\/]/).filter(Boolean))
  const common = []
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i]
    if (!split.every((s) => s[i] === seg)) break
    common.push(seg)
  }
  // A tool call names a file, so the last shared segment may be one. Walk back to a directory.
  for (let depth = common.length; depth > 1; depth--) {
    const candidate = root + common.slice(0, depth).join(path.sep)
    if (await isDir(candidate)) return candidate
  }
  return ''
}

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

/**
 * A Cursor prompt arrives wrapped: what you typed is inside `<user_query>`, and everything
 * the editor attached for you — open files, selections, plan documents — sits alongside it
 * in tags of its own. The query is lifted out first *and then* the tag-stripping runs, so
 * attachments are dropped without taking your actual question with them.
 */
function promptText(raw) {
  const query = /<user_query>([\s\S]*?)<\/user_query>/i.exec(raw)
  return String(query ? query[1] : raw)
    .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A prompt makes a poor title at full length; cut it at a sentence or a word, never mid-word. */
function titleFrom(prompt) {
  if (!prompt) return 'Untitled thread'
  const stop = prompt.search(/[.!?\n]/)
  const first = stop > 0 && stop < 80 ? prompt.slice(0, stop) : prompt
  if (first.length <= 80) return first
  const cut = first.slice(0, 80)
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`
}

/**
 * What a thread ended on. Only a `turn_ended` that failed for a reason that was not you
 * counts: 23 of the 25 failed turns on a real machine were `User aborted request`, and
 * badging every cancelled turn as blocked would drown the two that actually broke.
 */
function endedBadly(tail) {
  let last = null
  for (const r of jsonLines(tail)) {
    if (r?.type === 'turn_ended') last = r
  }
  if (!last || last.status === 'success') return ''
  const error = String(last.error || '')
  if (USER_ABORTS.some((re) => re.test(error))) return ''
  return error || last.status || 'failed'
}

/** Which branch that workspace is on, read straight out of `.git/HEAD` rather than by running git. */
async function gitBranch(dir) {
  try {
    const head = await fsp.readFile(path.join(dir, '.git', 'HEAD'), 'utf8')
    const m = /ref:\s*refs\/heads\/(.+)/.exec(head.trim())
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

/** Everything a transcript knows about itself, re-read only when the file has actually moved. */
async function transcriptMeta(file, stat) {
  const key = `${stat.mtimeMs}:${stat.size}`
  const hit = metaCache.get(file)
  if (hit && hit.key === key) return hit.meta

  const meta = { prompt: '', error: '', turns: 0 }
  try {
    const records = jsonLines(await readHead(file, HEAD_BYTES))
    for (const r of records) {
      if (r?.role === 'user' && r.message) {
        const text = promptText(firstText(r.message.content))
        if (text) {
          meta.prompt = text
          break
        }
      }
    }
    meta.error = endedBadly(await readTail(file, TAIL_BYTES, stat.size))
  } catch {
    /* a transcript being appended to right now is a normal thing to trip over */
  }
  metaCache.set(file, { key, meta })
  return meta
}

async function scanThreads() {
  const projectDirs = await listDirs(CURSOR_PROJECTS)
  const now = Date.now()
  const threads = []

  for (const projectDir of projectDirs) {
    const name = path.basename(projectDir)
    if (NOT_A_WORKSPACE.has(name)) continue
    // A numeric directory is a session Cursor never attached to a folder, and a temp path is
    // a scratch workspace. Neither is a repo, and neither should claim ground in the colony.
    if (/^\d+$/.test(name) || name.startsWith('var-folders') || name.startsWith('private-var')) continue

    const root = path.join(projectDir, TRANSCRIPTS)
    if (!(await exists(root))) continue

    for (const sessionDir of await listDirs(root)) {
      const sessionId = path.basename(sessionDir)
      const [file] = await listFiles(sessionDir, (f) => f.endsWith('.jsonl'))
      if (!file) continue

      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      if (!stat.size) continue

      const cwd = await resolveWorkspace(name, file)
      const meta = await transcriptMeta(file, stat)
      const branch = cwd ? await gitBranch(cwd) : ''

      threads.push({
        id: `cursor:${sessionId}`,
        title: titleFrom(meta.prompt),
        preview: meta.prompt.slice(0, 240),
        project: cwd ? path.basename(cwd) : name,
        projectPath: cwd,
        worktree: '',
        cwd,
        gitBranch: branch,
        model: '',
        effort: '',
        // Cursor stamps nothing, so the filesystem is the clock. Birthtime is not portable —
        // where it is missing it reads as 0 and the mtime stands in for both ends.
        createdAt: Math.round(stat.birthtimeMs) || Math.round(stat.mtimeMs),
        lastActivityAt: Math.round(stat.mtimeMs),
        lastFocusedAt: 0,
        running: now - stat.mtimeMs < ACTIVE_WINDOW_MS,
        // No focus history exists to compare against, so this is unknowable rather than false.
        // Claiming it would put a `?` over every Cursor thread you have ever opened.
        unread: false,
        hasError: Boolean(meta.error),
        starred: false,
        routine: '',
        prState: '',
        archived: false,
        sizeBytes: stat.size,
        source: 'cli',
        canOpen: Boolean(cwd),
        canArchive: false,
        ref: { sessionId, cwd },
      })
    }
  }
  return threads
}

/**
 * Cursor registers one URL scheme, `cursor://`, and publishes no way to address a single
 * chat through it — so there is nothing to navigate to and this deliberately does not
 * pretend otherwise. What it can do is put you back where the thread was working, which is
 * the closest true thing to handing it back. `newSession` below does exactly the same,
 * because for this harness they really are the same action.
 *
 * How the folder is opened matters more than it looks. `cursor://file/<dir>` is the
 * scheme's documented shape and it does bring the app to the front — and then opens
 * nothing, or whatever window was already there, because the handler is built for files.
 * The command line does what the scheme claims to: `cursor <dir>` opens that folder as a
 * workspace, in a new window if it is not already open, in the existing one if it is. So
 * that is used wherever it can be found, `open -a` on a Mac stands in when it cannot, and
 * the URL is the last resort rather than the first.
 */
function openThread(ref) {
  const dir = ref?.cwd
  if (!dir) return { ok: false, error: 'That thread has no workspace left on disk' }
  return openFolder(dir)
}

function newSession(dir) {
  return openFolder(dir)
}

/** Where Cursor's command line usually lives, most reliable first. */
const CURSOR_CLI = [
  '/usr/local/bin/cursor',
  '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  '/usr/bin/cursor',
  '/snap/bin/cursor',
  // No Windows entry on purpose. The launcher there is `cursor.cmd`, and a `.cmd` cannot
  // be spawned without a shell on any Node this project supports (CVE-2024-27980 made
  // that a synchronous EINVAL). Windows falls through to the URL, which opens the app.
]

export function openFolder(dir) {
  const cli = CURSOR_CLI.find((p) => existsSync(p))
  if (cli) return { ok: true, command: [cli, dir] }
  if (process.platform === 'darwin') return { ok: true, command: ['open', '-a', 'Cursor', dir] }
  return { ok: true, url: fileUrl(dir) }
}

/** `cursor://file/<abs>` — a URL path, so separators survive and only the rest is escaped. */
function fileUrl(dir) {
  const abs = dir.replace(/\\/g, '/')
  const rooted = abs.startsWith('/') ? abs : `/${abs}`
  return `cursor://file${rooted.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * `cursor-agent` has no archived list to put a thread in. Saying so is the documented answer:
 * the colony records the archive itself and the astronaut still walks back up the ramp.
 */
async function setArchived() {
  return { ok: false, error: 'cursor-agent has no archived state — hidden in the colony only' }
}

export default {
  id: 'cursor',
  name: 'Cursor',
  detect: async () => exists(CURSOR_PROJECTS),
  scanThreads,
  openThread,
  newSession,
  setArchived,
  paths: { CURSOR_PROJECTS },
}
