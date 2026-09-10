/**
 * Harness adapter: Codex (OpenAI), read in the browser.
 *
 * The sibling of `server/harnesses/codex.mjs`, over a directory handle for `~/.codex`. It reads
 * the rollout transcripts under `sessions/YYYY/MM/DD/rollout-*.jsonl` and the names Codex writes
 * to `session_index.jsonl`. The thread database (`state_<n>.sqlite`) is not opened here: that
 * needs a SQLite engine in the page, and everything the colony draws — cwd, branch, model, the
 * first prompt, whether a turn is running — is in the transcript. What the database would add
 * is the app's own title where the index has none, and its archive flag.
 *
 * Read-only, without exception.
 */
import { getDir, jsonLines, listDirs, listFiles, num, readHead, readTail, readText } from './fs-handle.js'

export const ID_PREFIX = 'codex'
const ID = (raw) => `${ID_PREFIX}:${raw}`

const HEAD_BYTES = 128 * 1024
const TAIL_BYTES = 64 * 1024
/** Codex writes nothing when it is killed, so a stale `task_started` needs a time bound too. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

const basename = (p) => {
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

const isAbsolute = (p) => typeof p === 'string' && (/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p))

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p === 'string' ? p : p?.text || p?.input_text || '')).filter(Boolean).join('\n')
}

/** What the head of a transcript knows about itself. */
function readHeadMeta(records) {
  const meta = { cwd: '', gitBranch: '', model: '', effort: '', createdAt: 0, prompt: '' }
  for (const r of records) {
    const p = r?.payload
    if (!p || typeof p !== 'object') continue
    if (r.type === 'session_meta') {
      meta.cwd ||= p.cwd || ''
      meta.gitBranch ||= p.git?.branch || ''
      meta.createdAt ||= Date.parse(p.timestamp || r.timestamp || '') || 0
    } else if (r.type === 'turn_context') {
      meta.cwd = p.cwd || meta.cwd
      meta.model = p.model || meta.model
      meta.effort = p.effort || meta.effort
    } else if (r.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      meta.prompt ||= clean(contentText(p.content))
    }
  }
  return meta
}

/**
 * The last lifecycle record. `task_started` with nothing after it is mid-turn; `turn_aborted` is
 * somebody pressing escape, which is not an error and must not redden an astronaut's eyes.
 */
function readLifecycle(records) {
  let last = null
  for (const r of records) {
    const p = r?.payload
    if (r?.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(p?.type)) {
      last = { type: p.type, error: Boolean(p.error) }
    }
  }
  return last
}

/** Every rollout transcript, keyed by the session id in its filename. */
async function scanRollouts(root) {
  const byId = new Map()
  const sessions = await getDir(root, 'sessions')
  if (!sessions) return byId
  for (const year of await listDirs(sessions)) {
    for (const month of await listDirs(year.handle)) {
      for (const day of await listDirs(month.handle)) {
        for (const file of await listFiles(day.handle, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
          const id = /([0-9a-f-]{36})\.jsonl$/i.exec(file.name)?.[1]
          if (!id || !UUID.test(id)) continue
          try {
            const f = await file.handle.getFile()
            byId.set(id, { id, handle: file.handle, size: f.size, mtime: f.lastModified })
          } catch {
            /* vanished between listing and read */
          }
        }
      }
    }
  }
  return byId
}

/** `thread_name` per session, when Codex has written one. */
async function readIndex(root) {
  const out = new Map()
  try {
    const file = await root.getFileHandle('session_index.jsonl')
    for (const row of jsonLines(await readText(file))) {
      if (row?.id && UUID.test(row.id)) out.set(row.id, row)
    }
  } catch {
    /* no index — every field it carries has another source */
  }
  return out
}

/** Parsing is kept against mtime and size, so an unchanged transcript is read once. */
const parseCache = new Map()
async function transcriptFacts(entry) {
  const cached = parseCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime && cached.size === entry.size) return cached.facts
  const facts = { lifecycle: null, meta: null }
  try {
    facts.lifecycle = readLifecycle(jsonLines(await readTail(entry.handle, TAIL_BYTES)))
    facts.meta = readHeadMeta(jsonLines(await readHead(entry.handle, HEAD_BYTES)))
  } catch {
    /* mid-write, or gone */
  }
  parseCache.set(entry.id, { mtime: entry.mtime, size: entry.size, facts })
  return facts
}

/** Does this folder look like `~/.codex`? */
export async function looksLikeCodexHome(root) {
  if (await getDir(root, 'sessions')) return true
  const files = await listFiles(root, (n) => n === 'session_index.jsonl' || /^state_\d+\.sqlite$/.test(n))
  return files.length > 0
}

export async function scanThreads(root) {
  const [rollouts, index] = await Promise.all([scanRollouts(root), readIndex(root)])
  const now = Date.now()
  const out = []
  for (const [id, entry] of rollouts) {
    const facts = await transcriptFacts(entry)
    const meta = facts.meta || {}
    const cwd = isAbsolute(meta.cwd) ? meta.cwd : ''
    const prompt = clean(meta.prompt)
    const title = clean(index.get(id)?.thread_name) || prompt || 'Untitled thread'
    out.push({
      id: ID(id),
      harness: ID_PREFIX,
      harnessName: 'Codex',
      title: title.slice(0, 120),
      preview: prompt.slice(0, 240),
      project: cwd ? basename(cwd) : 'unknown',
      projectPath: cwd,
      worktree: '',
      cwd,
      gitBranch: meta.gitBranch || '',
      model: meta.model || '',
      effort: meta.effort || '',
      createdAt: num(meta.createdAt) || entry.mtime,
      lastActivityAt: entry.mtime,
      lastFocusedAt: 0,
      unread: false,
      running: facts.lifecycle?.type === 'task_started' && now - entry.mtime < ACTIVE_WINDOW_MS,
      hasError: facts.lifecycle?.type === 'task_complete' && facts.lifecycle.error,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: entry.size,
      source: 'cli',
      canOpen: true,
      // `codex://` is registered by the Codex desktop app; the browser hands it to the OS.
      openUrl: `codex://threads/${id}`,
      openHint: '',
      ref: { sessionId: id },
    })
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return out
}

export const newSessionUrl = (dir) => `codex://threads/new?${new URLSearchParams({ path: dir })}`

export default {
  id: ID_PREFIX,
  name: 'Codex',
  folder: '.codex',
  looksLike: looksLikeCodexHome,
  scanThreads,
  newSessionUrl,
}
