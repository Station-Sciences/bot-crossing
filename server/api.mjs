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
 * One writer: the browser owns this file and PUTs it whole. `/api/archive` deliberately
 * does not touch it — if it did, the next save from a page holding older state would
 * silently drop every archive made since that page loaded.
 */
async function writeState(next) {
  const state = {
    version: STATE_VERSION,
    archived: asArray(next.archived),
    archivedAt: asObject(next.archivedAt),
    opened: asArray(next.opened),
    plots: asObject(next.plots),
    seen: asObject(next.seen),
    settings: next.settings && typeof next.settings === 'object' ? next.settings : null,
    updatedAt: Date.now(),
  }
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
  await fsp.rename(tmp, STATE_FILE)
  return state
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
/**
 * How much later than the archive itself a write has to be before it counts as the thread
 * coming back. Archiving a live thread makes the harness touch its own records, so a couple
 * of seconds of slack keeps that from reading as activity and undoing the archive instantly.
 */
const REVIVE_GRACE_MS = 5000

async function reconcileArchived(threads) {
  const state = await readState()
  if (!state.archived.length) return threads
  const wanted = new Set(state.archived)

  // One `ps` sweep per harness rather than one per thread.
  const startedAt = new Map()
  for (const id of new Set(threads.map((t) => t.harness))) {
    startedAt.set(id, await harnessAppStartedAt(id))
  }

  /**
   * An archive is remembered by the thread id the page saw, but that id is only the
   * *canonical* one: a thread keyed by a desktop record today can be keyed by its transcript
   * tomorrow, once the CLI writes one. Matching on the ids inside `ref` as well means an
   * archive survives that hand-over instead of the thread quietly reappearing under its new
   * name.
   */
  const isArchived = (thread) => {
    if (wanted.has(thread.id)) return true
    const ref = thread.ref || {}
    if (ref.cliSessionId && wanted.has(ref.cliSessionId)) return true
    return (ref.desktopSessionIds || []).some((id) => wanted.has(id))
  }

  return Promise.all(
    threads.map(async (thread) => {
      if (!isArchived(thread)) return thread
      if (!thread.archived && thread.canArchive) {
        await setThreadArchived(thread.harness, thread.ref, true).catch(() => {})
      }
      const ids = [thread.id, thread.ref?.cliSessionId, ...(thread.ref?.desktopSessionIds || [])]
      const at = Math.max(0, ...ids.map((id) => (id && state.archivedAt[id]) || 0))
      /**
       * A thread that has been worked on since you archived it is not archived any more.
       *
       * Archiving says "I am done with this". Going back to the session says the opposite,
       * and it is the more recent of the two — so the flag comes off rather than the colony
       * arguing with the harness about a thread you are visibly using. The page owns the
       * list, so it is told through `unarchivedByActivity` rather than written to here.
       */
      if (at && thread.lastActivityAt > at + REVIVE_GRACE_MS) {
        if (thread.archived && thread.canArchive) {
          await setThreadArchived(thread.harness, thread.ref, false).catch(() => {})
        }
        return { ...thread, archived: false, unarchivedByActivity: true }
      }

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
      const { harness, ref } = await readJsonBody(req)
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
      const result = harnessNewSession(harness || (await defaultHarness()), dir)
      if (result.ok) launch(result.url)
      return send(res, result.ok ? 200 : 400, result)
    }

    if (url.pathname === '/api/archive' && req.method === 'POST') {
      const { id, harness, ref, archived } = await readJsonBody(req)
      if (!id) return send(res, 400, { ok: false, error: 'Missing thread id' })

      // Only the harness's own records are touched here — the page records the intent. A
      // thread the harness has no record for is archived in the colony alone, which is a
      // success rather than a failure: the astronaut goes home either way.
      const records = ref?.desktopSessionIds?.length || 0
      if (!ref || !harness || !records) {
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
