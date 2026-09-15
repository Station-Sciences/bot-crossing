/**
 * Automations — one resident astronaut per automation folder.
 *
 * Every other adapter answers "which threads exist". This one answers "which automations
 * exist", and hands each one back shaped as a Thread so the colony can draw it without
 * knowing the difference. The astronaut is therefore permanent: it stands on its plot
 * whether or not anybody has ever opened a session there.
 *
 * It goes looking for life in exactly one place — Claude Code's own live-process files —
 * and matches them by working directory. That is what makes a resident hammer while you
 * type in the terminal, and stop when you close it.
 *
 * Point BOT_CROSSING_AUTOMATIONS at the folder that holds your automations. Each direct
 * subfolder is one automation. Read-only, like every adapter: nothing here writes.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exists, findExecutable, listDirs, listFiles } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/** The folder whose subfolders are your automations. No default — unset means no astronauts. */
const ROOT = process.env.BOT_CROSSING_AUTOMATIONS || ''

/** Claude Code's live-process files: {pid, sessionId, cwd, ...}. Stale files outlive their pid. */
const CLI_LIVE = path.join(HOME, '.claude', 'sessions')

/**
 * Ids are prefixed because the colony keys its archive list and saved layout on this string.
 * The slug is the folder name, so a resident keeps its plot and its archive state across
 * restarts — and loses them if you rename the folder, which is the honest outcome.
 */
const ID = (slug) => `automations:${slug}`

/** Anything that is not a plain, safe folder name is skipped rather than sanitised. */
const SAFE_SLUG = /^[\p{L}\p{N}_.@-][\p{L}\p{N}_.@ ()-]*$/u

/**
 * Which directories have a live Claude Code process in them right now.
 *
 * Signal 0 only tests that the pid exists, which is the cheap half. The expensive half —
 * deciding whether a *warmed* session counts as working — is deliberately not done here:
 * a resident is about your terminal being open on that folder, and a pre-warmed idle
 * process is still a session somebody left sitting in it.
 */
async function liveDirs() {
  const dirs = new Set()
  for (const file of await listFiles(CLI_LIVE, (n) => n.endsWith('.json'))) {
    let record
    try {
      record = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (!record.pid || typeof record.cwd !== 'string' || !record.cwd) continue
    try {
      process.kill(record.pid, 0)
      dirs.add(path.resolve(record.cwd))
    } catch {
      /* process is gone; the file outlived it */
    }
  }
  return dirs
}

/** Is `dir` the live directory, or does it contain it? A session in a subfolder still counts. */
function isLive(dir, live) {
  for (const cwd of live) {
    if (cwd === dir || cwd.startsWith(dir + path.sep)) return true
  }
  return false
}

/**
 * Optional per-automation metadata. Absent is the normal case — the folder name is enough —
 * so a missing or malformed file is never an error, just no overrides.
 */
async function meta(dir) {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dir, 'automation.json'), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/**
 * How finished the building looks. Only the folder's own top level is measured: walking the
 * whole tree would put a node_modules on the poll path, and the number is a log-scale visual
 * cue rather than a figure anybody reads.
 */
async function topLevelBytes(dir) {
  let total = 0
  let newest = 0
  for (const file of await listFiles(dir, () => true)) {
    try {
      const st = await fsp.stat(file)
      total += st.size
      if (st.mtimeMs > newest) newest = st.mtimeMs
    } catch {
      /* vanished mid-scan; a folder being written to is a normal thing to trip over */
    }
  }
  return { total, newest }
}

async function scanThreads() {
  if (!ROOT || !(await exists(ROOT))) return []

  const live = await liveDirs()
  const out = []

  for (const dir of await listDirs(ROOT)) {
    const slug = path.basename(dir)
    if (slug.startsWith('.') || !SAFE_SLUG.test(slug)) continue

    const [info, { total, newest }] = await Promise.all([meta(dir), topLevelBytes(dir)])
    let created = newest
    try {
      created = (await fsp.stat(dir)).birthtimeMs || newest
    } catch {
      /* keep the mtime fallback */
    }

    out.push({
      id: ID(slug),
      title: info.title || slug,
      preview: info.description || 'Automation — open a terminal here to start working',
      project: slug,
      projectPath: dir,
      worktree: '',
      cwd: dir,
      gitBranch: '',
      model: '',
      effort: '',
      createdAt: Math.round(created) || Date.now(),
      lastActivityAt: Math.round(newest) || Date.now(),
      lastFocusedAt: 0,
      running: isLive(dir, live),
      unread: false,
      hasError: false,
      archived: false,
      sizeBytes: total,
      source: 'resident',
      canOpen: true,
      ref: { slug, dir },
    })
  }

  return out
}

/**
 * Opening a resident is opening a terminal on its folder. There is no session to resume —
 * that is the whole point of a resident — so there is no deep link either, only a command.
 *
 * The binary is resolved against the user's own PATH and handed over absolute, because that
 * is what `openInTerminal` will accept and because an adapter never reaches into another
 * application's bundle.
 */
async function launchIn(dir) {
  if (!dir) return { ok: false, error: 'That automation has no folder on record' }
  // findExecutable takes a literal name, and on Windows `claude` is installed as `claude.cmd`.
  // PATHEXT is consulted in its own order so a shim the user actually has wins over our guess.
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  let bin = null
  for (const ext of exts) {
    bin = await findExecutable(`claude${ext.toLowerCase()}`)
    if (bin) break
  }
  if (!bin) return { ok: false, error: 'claude is not on your PATH — nothing to open a terminal with' }
  return { ok: true, command: { argv: [bin], cwd: dir } }
}

const openThread = (ref) => launchIn(ref && typeof ref.dir === 'string' ? ref.dir : '')
const newSession = (dir) => launchIn(dir)

export default {
  id: 'automations',
  name: 'Automations',
  detect: async () => Boolean(ROOT) && (await exists(ROOT)),
  scanThreads,
  openThread,
  newSession,
  paths: { ROOT, CLI_LIVE },
}
