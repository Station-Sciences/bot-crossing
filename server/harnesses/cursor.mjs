/**
 * Harness adapter: Cursor (Anysphere) — agent transcripts.
 *
 * Cursor writes one JSONL per agent session at
 * `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`. The records are
 * plainer than most: `{ role, message }` for each turn and, in recent versions, a
 * `{ type: 'turn_ended', status }` marker closing each one. There is no title, no cwd, no model
 * and no branch anywhere in the file — the encoded directory name and the first user message are
 * the whole of the metadata.
 *
 * Not covered: the composer / sidebar threads. Their bodies are not in these files — the
 * per-workspace `state.vscdb` holds only pane layout, and the global one is a couple of
 * gigabytes on a working machine and open read-write by the editor. Reading that on a
 * fifteen-second poll is its own piece of work, and guessing at its shape would be worse than
 * leaving it out and saying so.
 *
 * Read-only, no subprocess, and nothing is ever read from inside `Cursor.app`.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, listFiles, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const PROJECTS = process.env.BOT_CROSSING_CURSOR_PROJECTS || path.join(HOME, '.cursor', 'projects')
const TRANSCRIPTS = 'agent-transcripts'

const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 32 * 1024
/** Cursor writes nothing when it is killed, so an unclosed turn needs a time bound as well. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `cursor:${raw}`

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
  const now = Date.now()
  const threads = []

  for (const entry of entries) {
    const f = await facts(entry)
    const projectPath = await decodeProjectDir(entry.dirName)
    const prompt = f.prompt
    threads.push({
      id: ID(entry.id),
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
      canOpen: Boolean(projectPath),
      ref: { sessionId: entry.id, cwd: projectPath },
    })
  }
  return threads
}

/**
 * Cursor registers `cursor://`, but only for files and folders — nothing found so far addresses
 * a single agent thread, and inventing a route would be a link that silently does nothing.
 * So Open takes you to the repo in Cursor, which is one click from the thread, and the page
 * is told that is what happened rather than left to wonder why the thread did not appear.
 */
function openThread(ref) {
  const shown = newSession(ref?.cwd)
  if (!shown.ok) return { ok: false, error: 'Cursor has no link to a single thread, and this one has no folder to open either.' }
  return { ...shown, note: 'Cursor has no link to a single thread — opened the repo in Cursor; pick it from the agent list.' }
}

/** `cursor://file/<abs>` is answered by the installed app; the OS opener does the finding. */
function newSession(dir) {
  const abs = String(dir || '').replace(/\\/g, '/')
  if (!abs.startsWith('/')) return { ok: false, error: 'That folder is not somewhere Cursor can open' }
  return { ok: true, url: `cursor://file${abs.split('/').map(encodeURIComponent).join('/')}` }
}

const detect = () => exists(PROJECTS)

export default {
  id: 'cursor',
  name: 'Cursor',
  detect,
  scanThreads,
  openThread,
  newSession,
  paths: { PROJECTS },
}
