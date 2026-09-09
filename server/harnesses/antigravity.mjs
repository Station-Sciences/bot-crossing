/**
 * Harness adapter: Antigravity CLI (Google).
 *
 * Antigravity CLI stores sessions under `~/.gemini/antigravity-cli/brain/<sessionId>/`.
 * Transcripts are JSONL files located at `.system_generated/logs/transcript.jsonl`
 * or `transcript.jsonl` inside the session directory.
 *
 * Read-only, no subprocess, and no modifications to harness files.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, readHead, readTail, findExecutable } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const ANTIGRAVITY_HOME =
  process.env.BOT_CROSSING_ANTIGRAVITY_HOME ||
  process.env.ANTIGRAVITY_HOME ||
  path.join(HOME, '.gemini', 'antigravity-cli')
const BRAIN_DIR = path.join(ANTIGRAVITY_HOME, 'brain')

const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 32 * 1024
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `antigravity:${raw}`

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (typeof p === 'string' ? p : p?.text || p?.input_text || ''))
    .filter(Boolean)
    .join('\n')
}

/** Extract user query text from prompt/input record. */
function userText(record) {
  const raw = contentText(record?.content || record?.message?.content || '')
  // Strip XML-like wrapper tags if present
  const query = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw)
  const text = query ? query[1] : raw.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/gi, ' ')
  return clean(text)
}

/** Try to extract workspace/cwd from prompt user_information tags if present. */
function extractCwd(text) {
  const m = /active workspaces, each defined by a URI[\s\S]*?\[(.*?)\]\s*->/i.exec(text)
  if (m && path.isAbsolute(m[1])) return m[1]
  return ''
}

async function findTranscriptFile(sessionDir) {
  const candidates = [
    path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(sessionDir, 'transcript.jsonl'),
  ]
  for (const c of candidates) {
    if (await exists(c)) return c
  }
  return null
}

async function scanTranscripts() {
  const out = []
  for (const sessionDir of await listDirs(BRAIN_DIR)) {
    const id = path.basename(sessionDir)
    if (!UUID.test(id)) continue
    const file = await findTranscriptFile(sessionDir)
    if (!file) continue
    try {
      const st = await fsp.stat(file)
      if (!st.size) continue
      out.push({
        id,
        file,
        sessionDir,
        size: st.size,
        mtime: st.mtimeMs,
        born: st.birthtimeMs,
      })
    } catch {
      /* vanished */
    }
  }
  return out
}

const parseCache = new Map()
async function facts(entry) {
  const hit = parseCache.get(entry.id)
  if (hit && hit.mtime === entry.mtime && hit.size === entry.size) return hit.value

  const value = { prompt: '', cwd: '', startedAt: 0, closed: true, errored: false }
  try {
    for (const r of jsonLines(await readHead(entry.file, HEAD_BYTES))) {
      if (r?.type === 'USER_INPUT' || r?.role === 'user' || r?.source === 'USER_EXPLICIT') {
        const text = userText(r)
        if (!value.prompt && text) value.prompt = text
        const rawContent = String(r?.content || '')
        if (!value.cwd) value.cwd = r?.cwd || extractCwd(rawContent) || ''
        if (!value.startedAt && r?.created_at) {
          const t = Date.parse(r.created_at)
          if (!Number.isNaN(t)) value.startedAt = t
        }
        if (value.prompt && value.cwd && value.startedAt) break
      }
    }

    const tail = jsonLines(await readTail(entry.file, TAIL_BYTES))
    if (tail.length > 0) {
      const last = tail[tail.length - 1]
      value.errored = last?.status === 'ERROR' || Boolean(last?.error)
      value.closed = last?.status === 'DONE' || last?.status === 'COMPLETED' || last?.type === 'DONE'
    }
  } catch {
    /* mid-write, or vanished */
  }

  parseCache.set(entry.id, { mtime: entry.mtime, size: entry.size, value })
  return value
}

async function scanThreads() {
  const entries = await scanTranscripts()
  const now = Date.now()
  const threads = []

  for (const entry of entries) {
    const f = await facts(entry)
    const cwd = f.cwd || ''
    const projectPath = cwd
    const project = cwd ? path.basename(cwd) : 'unknown'
    const prompt = f.prompt

    threads.push({
      id: ID(entry.id),
      title: (prompt || 'Untitled thread').slice(0, 120),
      preview: prompt.slice(0, 240),
      project,
      projectPath,
      worktree: '',
      cwd,
      gitBranch: '',
      model: 'antigravity',
      effort: '',
      createdAt: f.startedAt || entry.born || entry.mtime,
      lastActivityAt: entry.mtime,
      lastFocusedAt: 0,
      unread: false,
      running: !f.closed && now - entry.mtime < ACTIVE_WINDOW_MS,
      hasError: f.errored,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: entry.size,
      source: 'cli',
      canOpen: true,
      ref: { sessionId: entry.id, cwd },
    })
  }
  return threads
}

async function openThread(ref) {
  const id = ref?.sessionId
  if (typeof id !== 'string' || !UUID.test(id)) {
    return { ok: false, error: 'No openable Antigravity session id on that thread' }
  }
  const cwd = typeof ref?.cwd === 'string' ? ref.cwd : ''
  const bin = (await findExecutable('antigravity')) || (await findExecutable('antigravity-cli'))
  const url = `antigravity://resume?session=${id}`
  let command
  if (bin) {
    command = { argv: [bin, '--resume', id], cwd }
  }
  return { ok: true, url, command }
}

async function newSession(dir) {
  const abs = String(dir || '').replace(/\\/g, '/')
  if (!abs.startsWith('/')) return { ok: false, error: 'That folder is not somewhere Antigravity can open' }
  const bin = (await findExecutable('antigravity')) || (await findExecutable('antigravity-cli'))
  const url = `antigravity://new?${new URLSearchParams({ path: abs })}`
  let command
  if (bin) {
    command = { argv: [bin], cwd: abs }
  }
  return { ok: true, url, command }
}

const detect = () => exists(BRAIN_DIR)

export default {
  id: 'antigravity',
  name: 'Antigravity CLI',
  detect,
  scanThreads,
  openThread,
  newSession,
  paths: { ANTIGRAVITY_HOME, BRAIN_DIR },
}
