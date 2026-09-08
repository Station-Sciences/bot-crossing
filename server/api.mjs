import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  defaultHarness,
  harnessAppStartedAt,
  harnessStatus,
  newSession as harnessNewSession,
  openThread as harnessOpenThread,
  scanThreads,
  setThreadArchived,
} from './scan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', 'data')
const STATE_FILE = path.join(DATA_DIR, 'colony.json')

const STATE_VERSION = 1

/**
 * Colony state is only ever the things the *game* invents — which plot a project got,
 * what a thread's building looks like, what you archived. The threads themselves stay
 * read-only: nothing here ever writes to a harness's data except the one archive flag.
 */
const emptyState = () => ({
  version: STATE_VERSION,
  archived: [],
  archivedAt: {},
  opened: [],
  plots: {},
  seen: {},
  settings: null,
  updatedAt: 0,
})

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArray = (v) => (Array.isArray(v) ? v : [])

async function readState() {
  try {
    const raw = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'))
    return {
      version: STATE_VERSION,
      archived: asArray(raw.archived),
      archivedAt: asObject(raw.archivedAt),
      opened: asArray(raw.opened),
      plots: asObject(raw.plots),
      seen: asObject(raw.seen),
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return emptyState()
  }
}

/**
 * Split ownership. The page PUTs layout/seen/opened/settings whole, but the archive list
 * belongs to the server: `/api/archive` writes it straight into this file, and a PUT keeps
 * whatever is on disk. Otherwise a page holding older state (or a second tab, or a script
 * hitting `/api/archive` directly) would silently drop every archive made since it loaded.
 * Writes are chained so two requests never race on the temp file.
 */
let stateWriteChain = Promise.resolve()

function withStateLock(fn) {
  const run = stateWriteChain.then(fn, fn)
  stateWriteChain = run.then(() => undefined, () => undefined)
  return run
}

async function persistState(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
  await fsp.rename(tmp, STATE_FILE)
  return state
}

function writeState(next) {
  return withStateLock(async () => {
    const current = await readState()
    return persistState({
      version: STATE_VERSION,
      archived: current.archived,
      archivedAt: current.archivedAt,
      opened: asArray(next.opened),
      plots: asObject(next.plots),
      seen: asObject(next.seen),
      settings: next.settings && typeof next.settings === 'object' ? next.settings : null,
      updatedAt: Date.now(),
    })
  })
}

/** Add or remove one thread id from the on-disk archive list. */
function setColonyArchived(id, archived) {
  return withStateLock(async () => {
    const current = await readState()
    const archivedAt = { ...current.archivedAt }
    let list
    if (archived) {
      list = [...new Set([...current.archived, id])]
      archivedAt[id] = archivedAt[id] || Date.now()
    } else {
      list = current.archived.filter((x) => x !== id)
      delete archivedAt[id]
    }
    return persistState({ ...current, archived: list, archivedAt, updatedAt: Date.now() })
  })
}

/**
/**
 * Hand a `harness://…` deep link, or a folder, to whatever opens things on this OS. The
 * opener gets an argument list, never a shell string.
 *
 * macOS's `open(1)` does both jobs, and `xdg-open` is the Linux equivalent. On Windows the
 * equivalent is ShellExecute, reached through `rundll32 url.dll,FileProtocolHandler`: a
 * registered protocol URL goes to its app and a folder opens in Explorer, with the argument
 * passed through untouched. Two more obvious routes were tried and rejected — `explorer.exe
 * <url>` silently drops any URL that carries a query string, so `code/new?folder=…` never
 * arrived, and `cmd /c start` parses its own argument line, where the `%3A%5C` escapes in that
 * same link are exactly what it expands.
 *
 * The spawn is guarded because the opener may simply not be installed — a headless Linux box
 * has no `xdg-open` — and an unhandled `error` event on a child process takes the whole server
 * down. Failing quietly is right here: there is nothing the page could do with the error, and
 * the scan path must never depend on whether presentation worked.
 */
const OPENERS = {
  darwin: ['open'],
  win32: ['rundll32', 'url.dll,FileProtocolHandler'],
  linux: ['xdg-open'],
}

function launch(target) {
  const opener = OPENERS[process.platform]
  if (!opener) return
  const [cmd, ...args] = opener
  const child = spawn(cmd, [...args, target], { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

/**
 * Opt-in: `BOT_CROSSING_OPEN=cli` makes Open / New conversation spawn a terminal running the
 * `claude` CLI in the thread's folder instead of handing a `claude://` link to the desktop
 * app. Arguments go to spawn as a list — never a shell string — and the session id is
 * pattern-checked by the caller, so nothing from the page can inject into the command.
 */
const OPEN_IN_CLI = process.env.BOT_CROSSING_OPEN === 'cli'
const CLI_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function spawnDetached(cmd, args, dir, onError) {
  const child = spawn(cmd, args, { cwd: dir, stdio: 'ignore', detached: true })
  child.on('error', onError || (() => {}))
  child.unref()
}

function launchCli(dir, claudeArgs) {
  const cmdLine = ['claude', ...claudeArgs]
  let cmd
  let args
  if (process.platform === 'win32') {
    // Windows Terminal when installed; a plain console window otherwise.
    spawnDetached('wt', ['-d', dir, ...cmdLine], dir, () =>
      spawnDetached('cmd', ['/c', 'start', '""', '/D', dir, 'cmd', '/k', ...cmdLine], dir),
    )
    return
  } else if (process.platform === 'darwin') {
    const script = `cd ${JSON.stringify(dir)} && ${cmdLine.map((a) => JSON.stringify(a)).join(' ')}`
    cmd = 'osascript'
    args = ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate']
  } else {
    cmd = 'x-terminal-emulator'
    args = ['-e', ...cmdLine]
  }
  spawnDetached(cmd, args, dir)
}

/**
 * A folder is openable only if it is still on this machine and still a directory. Paths
 * arrive from the page, which got them from a scan that may be minutes old — a repo that
 * has since been moved or deleted must fail here rather than hand the opener a dead path.
 * Absolute is judged by `path.isAbsolute` rather than a leading `/`, which no Windows path has.
 */
async function resolveFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null
  const dir = path.resolve(folder)
  const stat = await fsp.stat(dir).catch(() => null)
  return stat && stat.isDirectory() ? dir : null
}

/**
 * A harness loads its session records at launch and rewrites them whenever it touches one,
 * which silently clears an archive flag set from outside. So the colony keeps its own list
 * and re-asserts the flag on every scan; an archive that gets stomped comes back within one
 * poll. `archivePending` is true while the flag is on disk but the running app has not read
 * it yet — that astronaut is walking to the ship but has not boarded.
 */
async function reconcileArchived(threads) {
  const state = await readState()
  if (!state.archived.length) return threads
  const wanted = new Set(state.archived)

  // One `ps` sweep per harness rather than one per thread.
  const startedAt = new Map()
  for (const id of new Set(threads.map((t) => t.harness))) {
    startedAt.set(id, await harnessAppStartedAt(id))
  }

  return Promise.all(
    threads.map(async (thread) => {
      if (!wanted.has(thread.id)) return thread
      if (!thread.archived && thread.canArchive) {
        await setThreadArchived(thread.harness, thread.ref, true).catch(() => {})
      }
      const at = state.archivedAt[thread.id] ?? 0
      const appStart = startedAt.get(thread.harness) || 0
      return { ...thread, archived: true, archivePending: !(appStart && appStart > at) }
    })
  )
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// The machine's own LAN addresses count as local too, so the colony can be
// served to the home network with BOT_CROSSING_HOST set. Harmless when bound
// to loopback (those hosts can't reach the server anyway), and the Host +
// Origin pairing still stops DNS rebinding and CSRF exactly as before.
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a && a.family === 'IPv4' && !a.internal && a.address) LOCAL_HOSTS.add(a.address)
  }
}

/** Hostname out of a `Host:` or `Origin:` value, with the port and any brackets stripped. */
function hostnameOf(value) {
  if (!value) return ''
  const raw = String(value).includes('://') ? value : `http://${value}`
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/**
 * Only a page this server itself served may drive it. Two checks, against two different
 * attacks, both of which a localhost server with an `open`-the-desktop-app button is a
 * genuinely attractive target for:
 *
 *   - **Host** stops DNS rebinding. Binding to 127.0.0.1 is not on its own enough: an
 *     attacker who points `evil.com` at 127.0.0.1 reaches us *as a same-origin page*, and
 *     can then read every response. The rebound request still carries `Host: evil.com`.
 *   - **Origin** stops CSRF. A cross-site `fetch` with a `text/plain` body is not
 *     preflighted, so without this check any page you happened to be visiting could POST
 *     here — spawning sessions, opening Finder windows, or wiping the colony layout —
 *     even though it could never read the reply.
 *
 * A state-changing request with no `Origin` at all is refused: browsers always send one on
 * POST/PUT, so its absence means the caller is not the page. That does mean a bare `curl`
 * POST is rejected; pass `-H 'Origin: http://localhost:5274'` if you are scripting this.
 */
function isLocalRequest(req) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return false

  const origin = req.headers.origin
  if (origin && origin !== 'null') return LOCAL_HOSTS.has(hostnameOf(origin))
  return req.method === 'GET' || req.method === 'HEAD'
}

function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** Connect-style middleware: handles /api/*, passes everything else through. */
export async function apiMiddleware(req, res, next) {
  const url = new URL(req.url, 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'Not found' })

  if (!isLocalRequest(req)) {
    return send(res, 403, { error: 'Bot Crossing only answers its own page on this machine' })
  }

  try {
    if (url.pathname === '/api/threads' && req.method === 'GET') {
      const threads = await reconcileArchived(await scanThreads())
      return send(res, 200, { threads, scannedAt: Date.now() })
    }

    if (url.pathname === '/api/harnesses' && req.method === 'GET') {
      return send(res, 200, { harnesses: await harnessStatus() })
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, await readState())
    }

    if (url.pathname === '/api/state' && req.method === 'PUT') {
      return send(res, 200, await writeState(await readJsonBody(req)))
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const { harness, ref, cwd } = await readJsonBody(req)
      if (OPEN_IN_CLI) {
        const sessionId = ref && ref.cliSessionId
        const dir = await resolveFolder(cwd)
        if (sessionId && CLI_SESSION_ID.test(sessionId) && dir) {
          launchCli(dir, ['--resume', sessionId])
          return send(res, 200, { ok: true, cli: true })
        }
        // No CLI session or a folder that is gone: fall back to the desktop deep link.
      }
      const result = harnessOpenThread(harness, ref)
      if (result.ok) launch(result.url)
      return send(res, result.ok ? 200 : 400, result)
    }

    if ((url.pathname === '/api/new-session' || url.pathname === '/api/reveal') && req.method === 'POST') {
      const { folder, harness } = await readJsonBody(req)
      const dir = await resolveFolder(folder)
      if (!dir) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })

      if (url.pathname === '/api/reveal') {
        launch(dir)
        return send(res, 200, { ok: true })
      }
      if (OPEN_IN_CLI) {
        launchCli(dir, [])
        return send(res, 200, { ok: true, cli: true })
      }
      const result = harnessNewSession(harness || (await defaultHarness()), dir)
      if (result.ok) launch(result.url)
      return send(res, result.ok ? 200 : 400, result)
    }

    if (url.pathname === '/api/archive' && req.method === 'POST') {
      const { id, harness, ref, archived } = await readJsonBody(req)
      if (!id) return send(res, 400, { ok: false, error: 'Missing thread id' })

      // The colony's own list is written here, so it survives a stale page saving over it.
      await setColonyArchived(id, Boolean(archived))

      if (!ref || !harness) {
        return send(res, 200, {
          ok: true,
          archived: Boolean(archived),
          harnessRecord: false,
          note: 'Archived in the colony. That harness has no session record for this thread.',
        })
      }
      const result = await setThreadArchived(harness, ref, archived)
      return send(res, 200, { ...result, ok: true, archived: Boolean(archived), harnessRecord: result.ok })
    }

    return send(res, 404, { error: 'Unknown endpoint' })
  } catch (err) {
    return send(res, 500, { error: String(err && err.message ? err.message : err) })
  }
}
