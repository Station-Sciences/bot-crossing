/**
 * Harness adapter: Cursor (Anysphere), read in the browser.
 *
 * The sibling of `server/harnesses/cursor.mjs`, over a directory handle for `~/.cursor`. One
 * JSONL per agent session at `projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`;
 * `{ role, message }` per turn and, in recent versions, a `{ type: 'turn_ended', status }`
 * marker closing each one. No title, cwd, model or branch anywhere in the file.
 *
 * The encoded directory name is lossy — every path separator became a dash, and so did every
 * dash already in a folder name. The server adapter resolves it against the disk; a page cannot
 * stat arbitrary paths, so it resolves against the paths the other harnesses have already
 * named on this machine (a repo worked on from Claude Code or Codex too), and otherwise keeps
 * the dashed remainder as one name after the home prefix.
 *
 * Read-only, without exception.
 */
import { getDir, jsonLines, listDirs, listFiles, readHead, readTail } from './fs-handle.js'

export const ID_PREFIX = 'cursor'
const ID = (raw) => `${ID_PREFIX}:${raw}`

const TRANSCRIPTS = 'agent-transcripts'
const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 32 * 1024
/** Cursor writes nothing when it is killed, so an unclosed turn needs a time bound as well. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const basename = (p) => {
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

/** A path the way Cursor names its project folder: separators and leading slash to dashes. */
const encodePath = (p) => String(p).replace(/^[\\/]+/, '').replace(/[\\/]/g, '-')

/**
 * Best reading of an encoded name. A known path whose encoding matches wins outright. Failing
 * that, the home prefix (`Users-<name>` or `home-<name>`) is split back into a path and the
 * rest stands as one dashed name — a folder called `emra-app-builder` is far likelier than
 * three nested single-word folders.
 */
function decodeProjectDir(name, knownPaths) {
  for (const p of knownPaths) if (encodePath(p) === name) return p
  const tokens = name.split('-').filter(Boolean)
  const home = /^(Users|home)$/.test(tokens[0] || '') && tokens.length >= 3 ? 2 : 0
  const head = tokens.slice(0, home)
  const rest = tokens.slice(home)
  if (!rest.length) return `/${head.join('/')}`
  // Whatever a known path already proves is a directory chain peels off one token at a time.
  const known = new Set(knownPaths.map((p) => p.replace(/^[\\/]+/, '').split(/[\\/]/).join('-')))
  let prefix = head
  let i = 0
  while (i < rest.length - 1 && [...known].some((k) => k.startsWith([...prefix, rest[i]].join('-') + '-'))) {
    prefix = [...prefix, rest[i]]
    i++
  }
  return `/${[...prefix, rest.slice(i).join('-')].join('/')}`
}

/** Only the query is something a person typed. */
function userText(record) {
  const parts = record?.message?.content
  const raw = Array.isArray(parts)
    ? parts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
    : String(parts || '')
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(raw)
  const text = query ? query[1] : raw.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/gi, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

function stamp(record) {
  const parts = record?.message?.content
  const raw = Array.isArray(parts) ? parts.map((p) => p?.text || '').join('\n') : ''
  const m = /<timestamp>(.*?)<\/timestamp>/.exec(raw)
  const t = m ? Date.parse(m[1].replace(/\s*\(UTC[^)]*\)\s*$/, '')) : NaN
  return Number.isNaN(t) ? 0 : t
}

async function scanTranscripts(root) {
  const out = []
  const projects = await getDir(root, 'projects')
  if (!projects) return out
  for (const projectDir of await listDirs(projects)) {
    const transcripts = await getDir(projectDir.handle, TRANSCRIPTS)
    if (!transcripts) continue
    for (const sessionDir of await listDirs(transcripts)) {
      if (!UUID.test(sessionDir.name)) continue
      for (const file of await listFiles(sessionDir.handle, (n) => n.endsWith('.jsonl'))) {
        try {
          const f = await file.handle.getFile()
          if (!f.size) continue
          out.push({ id: sessionDir.name, handle: file.handle, dirName: projectDir.name, size: f.size, mtime: f.lastModified })
        } catch {
          /* vanished between listing and read */
        }
      }
    }
  }
  return out
}

const cache = new Map()
async function facts(entry) {
  const hit = cache.get(entry.id)
  if (hit && hit.mtime === entry.mtime && hit.size === entry.size) return hit.value
  const value = { prompt: '', startedAt: 0, closed: true, modern: false, errored: false }
  try {
    for (const r of jsonLines(await readHead(entry.handle, HEAD_BYTES))) {
      if (r?.role !== 'user') continue
      value.prompt = userText(r)
      value.startedAt = stamp(r)
      break
    }
    const tail = jsonLines(await readTail(entry.handle, TAIL_BYTES))
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

export async function looksLikeCursorHome(root) {
  return Boolean(await getDir(root, 'projects'))
}

/** `knownPaths` are project paths other harnesses have already named, for decoding folder names. */
export async function scanThreads(root, { knownPaths = [] } = {}) {
  const entries = await scanTranscripts(root)
  const now = Date.now()
  const threads = []
  for (const entry of entries) {
    const f = await facts(entry)
    const projectPath = decodeProjectDir(entry.dirName, knownPaths)
    const prompt = f.prompt
    threads.push({
      id: ID(entry.id),
      harness: ID_PREFIX,
      harnessName: 'Cursor',
      title: (prompt || 'Untitled thread').slice(0, 120),
      preview: prompt.slice(0, 240),
      project: basename(projectPath) || 'unknown',
      projectPath,
      worktree: '',
      cwd: projectPath,
      gitBranch: '',
      model: '',
      effort: '',
      createdAt: f.startedAt || entry.mtime,
      lastActivityAt: entry.mtime,
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
      // Cursor registers `cursor://` for files and folders only; nothing addresses one thread.
      canOpen: false,
      openUrl: '',
      openHint: 'Cursor has no link to a single thread — open the repo and pick it from the agent list',
      ref: { sessionId: entry.id, cwd: projectPath },
    })
  }
  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return threads
}

/** `cursor://file/<abs>` is answered by the installed app. */
export const newSessionUrl = (dir) => {
  const abs = String(dir || '').replace(/\\/g, '/')
  if (!abs.startsWith('/')) return ''
  return `cursor://file${abs.split('/').map(encodeURIComponent).join('/')}`
}

export default {
  id: ID_PREFIX,
  name: 'Cursor',
  folder: '.cursor',
  looksLike: looksLikeCursorHome,
  scanThreads,
  newSessionUrl,
}
