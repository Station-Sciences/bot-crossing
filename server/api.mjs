import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openInTerminal, schemeHasHandler, schemeOf } from './lib/xdg.mjs'
import {
  defaultHarness,
  harnessStatus,
  newSession as harnessNewSession,
  openThread as harnessOpenThread,
  scanThreads,
} from './scan.mjs'
import { pluginManager } from './plugins.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', 'data')
const STATE_FILE = path.join(DATA_DIR, 'colony.json')

const STATE_VERSION = 2

/**
 * v1 keyed everything on a bare session id, because Claude Code was the only harness and its
 * ids are UUIDs. Adapters now prefix (`claude-code:…`, `codex:…`) so two harnesses can never
 * name the same thread, which means a v1 file's archive list no longer matches anything.
 *
 * Only Claude Code ever wrote a bare id, so the rewrite is unambiguous. One shot, on read.
 */
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const migrateId = (id) => (BARE_UUID.test(id) ? `claude-code:${id}` : id)

function migrate(raw) {
  if (Number(raw.version) >= 2) return raw
  const keys = (o) => Object.fromEntries(Object.entries(asObject(o)).map(([k, v]) => [migrateId(k), v]))
  return {
    ...raw,
    archived: asArray(raw.archived).map(migrateId),
    archivedAt: keys(raw.archivedAt),
    opened: asArray(raw.opened).map(migrateId),
    seen: keys(raw.seen),
    viewedAt: keys(raw.viewedAt),
  }
}

/**
 * Colony state is only ever the things the *game* invents — which plot a project got,
 * what a thread's building looks like, what you archived, which repos you took off the map.
 * The threads themselves stay
 * read-only: this file is the only thing Bot Crossing writes, anywhere.
 */
const emptyState = () => ({
  version: STATE_VERSION,
  archived: [],
  archivedAt: {},
  opened: [],
  plots: {},
  seen: {},
  hiddenProjects: [],
  viewedAt: {},
  settings: null,
  updatedAt: 0,
})

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArray = (v) => (Array.isArray(v) ? v : [])

async function readState() {
  try {
    const raw = migrate(JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')))
    return {
      version: STATE_VERSION,
      archived: asArray(raw.archived),
      archivedAt: asObject(raw.archivedAt),
      opened: asArray(raw.opened),
      plots: asObject(raw.plots),
      seen: asObject(raw.seen),
      hiddenProjects: asArray(raw.hiddenProjects).map(String).filter(Boolean),
      viewedAt: asObject(raw.viewedAt),
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return emptyState()
  }
}

/**
 * One writer: the browser owns this file and PUTs it whole. Nothing on the server writes it —
 * if anything did, the next save from a page holding older state would silently drop every
 * archive made since that page loaded.
 */
/**
 * Writes are serialised through one chain, and each gets its own temp file.
 *
 * Both halves matter and neither is theoretical. A shared `colony.json.tmp` means two saves
 * landing together race on the rename and one throws ENOENT — a 500 the page has no idea what
 * to do with, so the save is simply lost. And read-then-write is not atomic across an `await`,
 * so without the chain two callers can both pass the version check below before either writes.
 */
let writeQueue = Promise.resolve()
let tmpSeq = 0
const serialise = (fn) => (writeQueue = writeQueue.then(fn, fn))

async function writeState(next) {
  const state = {
    version: STATE_VERSION,
    archived: asArray(next.archived),
    archivedAt: asObject(next.archivedAt),
    opened: asArray(next.opened),
    plots: asObject(next.plots),
    seen: asObject(next.seen),
    hiddenProjects: asArray(next.hiddenProjects).map(String).filter(Boolean),
    viewedAt: asObject(next.viewedAt),
    settings: next.settings && typeof next.settings === 'object' ? next.settings : null,
    updatedAt: Date.now(),
  }
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
    await fsp.rename(tmp, STATE_FILE)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return state
}

/**
/**
 * Hand a `harness://…` deep link, or a folder, to whatever opens things on this OS. The
 * opener gets an argument list, never a shell string.
 *
 * Only `present()` calls this, and no harness knowledge ever reaches it: an adapter says what it
 * wants opened and this decides how, which is the seam that keeps `server/harnesses/` swappable.
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
 * Show a harness's answer to "open this" — `{ ok, url, command }` — and say truthfully whether
 * anything happened.
 *
 * macOS and Windows hand the URL to the opener exactly as before: a scheme the harness's app
 * registers is always answered there, so nothing is probed. Linux is the platform where the URL
 * may have nowhere to go — the desktop app is optional and often absent, and `xdg-open` on a
 * scheme nobody claims exits quietly, which used to reach the page as "Opened". So there the
 * scheme is checked first; failing that, the harness's own CLI runs in a terminal, from the
 * `command` the adapter offered alongside the URL; failing that, the page is told so.
 *
 * `command.cwd` came from the page — inside `ref`, or as the folder itself — so it gets the same
 * check as any other folder the page names. There is no fallback directory on purpose:
 * `claude --resume` looks a session up under the folder it ran in, and a terminal that opens on
 * "No conversation found" and closes is worse than an error toast.
 */
async function present(result) {
  // Only the reason reaches the page: a failure may still carry the adapter's command.
  if (!result || !result.ok) return { ok: false, error: result?.error || 'Nothing to open' }

  if (process.platform !== 'linux') {
    if (!result.url) return { ok: false, error: 'That harness has no deep link to open on this platform' }
    launch(result.url)
    return { ok: true, url: result.url }
  }

  if (result.url && (await schemeHasHandler(result.url))) {
    launch(result.url)
    return { ok: true, url: result.url }
  }
  if (result.command) {
    if (!result.command.cwd) return { ok: false, error: 'That thread has no folder on record to resume in' }
    const cwd = await resolveFolder(result.command.cwd)
    if (!cwd) return { ok: false, error: 'The folder that thread ran in is not on this machine any more' }
    // A folder that exists but cannot be entered fails inside every terminal alike, and the
    // terminal gets the blame; say what is actually wrong instead.
    const enterable = await fsp.access(cwd, fsp.constants.X_OK).then(() => true, () => false)
    if (!enterable) return { ok: false, error: 'The folder that thread ran in cannot be entered' }
    return openInTerminal(result.command.argv, cwd)
  }
  const scheme = schemeOf(result.url)
  return {
    ok: false,
    error: scheme
      ? `Nothing on this machine opens ${scheme}:// links, and there is no CLI command to run instead`
      : 'Nothing on this machine can open that',
  }
}

/**
 * Mark the threads the colony has retired.
 *
 * Nothing is written anywhere. Bot Crossing used to set `isArchived` on the desktop app's own
 * session record, and it did land on disk — but the app serves from the copy it loaded at
 * launch, so the thread stayed put in its own list until the next restart, and the app would
 * rewrite the record from memory whenever it touched the thread. Papering over that took a
 * re-assert on every poll, a `ps` sweep to guess whether the app had re-read the file, and a
 * *pending* state for the gap between the two — a lot of machinery for something that still
 * looked broken to anyone with the app open.
 *
 * So the colony keeps its own list and that is all it does. Archiving in the harness's own UI
 * still sends the astronaut home, because the scan reads that flag; archiving here is the
 * colony's own business. Nothing outside `data/colony.json` is ever written.
 */
async function reconcileArchived(threads) {
  const state = await readState()
  if (!state.archived.length) return threads
  const wanted = new Set(state.archived)

  /**
   * An archive is remembered by the thread id the page saw, but that id is only the *canonical*
   * one. A thread the desktop app knows and the CLI has not written a transcript for is keyed on
   * its desktop record; the moment a transcript appears it re-keys to that session's UUID, and a
   * list keyed on the old string stops matching. The thread quietly comes back, which reads as
   * the archive having failed.
   *
   * So the ids inside `ref` count too. They are opaque to everything else here — this only ever
   * asks whether a string it already holds appears among them.
   */
  const archived = (thread) => {
    if (wanted.has(thread.id)) return true
    const ref = thread.ref
    if (!ref || typeof ref !== 'object') return false
    for (const value of Object.values(ref)) {
      if (typeof value === 'string') {
        if (value && wanted.has(value)) return true
      } else if (Array.isArray(value)) {
        for (const v of value) if (typeof v === 'string' && v && wanted.has(v)) return true
      }
    }
    return false
  }

  return threads.map((t) => (archived(t) ? { ...t, archived: true } : t))
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

  if (url.pathname.startsWith('/plugins/')) {
    const rel = decodeURIComponent(url.pathname).replace(/^\/plugins\//, '')
    let filePath = path.resolve(path.join(here, '..', 'plugins'), rel)
    if (!fs.existsSync(filePath)) {
      filePath = path.resolve(path.join(here, '..', '..', 'bot-crossing-plugins', 'packages'), rel)
    }
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      const ext = path.extname(filePath)
      const type = ext === '.js' || ext === '.mjs' ? 'text/javascript; charset=utf-8' :
                   ext === '.css' ? 'text/css; charset=utf-8' :
                   ext === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream'
      const content = fs.readFileSync(filePath)
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-cache' })
      return res.end(content)
    }

    // Dynamic Remote Fallback: Stream directly from GitHub BeerCanLabs/bot-crossing-plugins
    try {
      const remoteUrl = `https://raw.githubusercontent.com/BeerCanLabs/bot-crossing-plugins/main/packages/${rel}`
      const remoteRes = await fetch(remoteUrl)
      if (remoteRes.ok) {
        const ext = path.extname(rel)
        const type = ext === '.js' || ext === '.mjs' ? 'text/javascript; charset=utf-8' :
                     ext === '.css' ? 'text/css; charset=utf-8' :
                     ext === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream'
        const buf = Buffer.from(await remoteRes.arrayBuffer())
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=300' })
        return res.end(buf)
      }
    } catch (err) {
      console.warn(`[Plugins] Remote asset fetch error for ${rel}:`, err.message)
    }

    return send(res, 404, { error: 'Plugin asset not found' })
  }

  if (!isLocalRequest(req)) {
    return send(res, 403, { error: 'Bot Crossing only answers its own page on this machine' })
  }

  // Intercept with active plugins if configured
  let pluginsHandled = false
  await pluginManager.middleware(req, res, () => {
    pluginsHandled = true
  })
  if (!pluginsHandled) return

  try {
    if (url.pathname === '/api/plugins' && req.method === 'GET') {
      return send(res, 200, await pluginManager.getStatus())
    }

    if (url.pathname === '/api/plugins/client-scripts' && req.method === 'GET') {
      return send(res, 200, { scripts: pluginManager.getClientScripts() })
    }

    if (url.pathname === '/api/threads' && req.method === 'GET') {
      const threads = await reconcileArchived(await scanThreads())
      // A harness that is present but cannot read its own store says so here, rather than
      // appearing healthy in the list while quietly contributing nothing.
      const warnings = (await harnessStatus()).filter((h) => h.detected && h.error).map((h) => h.error)
      return send(res, 200, { threads, scannedAt: Date.now(), warnings })
    }

    if (url.pathname === '/api/harnesses' && req.method === 'GET') {
      return send(res, 200, { harnesses: await harnessStatus() })
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, await readState())
    }

    /**
     * Optimistic concurrency, so a second tab cannot paste over the first one's work.
     *
     * `baseUpdatedAt` is the version the caller last agreed with. If the file no longer carries
     * it, the caller's whole-file body describes a colony that no longer exists — so the disk
     * state comes back with a 409 and the page merges against it. Merging here was the other
     * option and it is the wrong place: the server has no idea which of two `plots` layouts a
     * person actually dragged.
     *
     * The test is inequality rather than "older than", because a colony file also moves
     * *backwards* — restored from a backup, edited by hand — and a page open across that holds
     * a base newer than disk, which sails through a greater-than check and pastes the
     * pre-restore colony straight back.
     *
     * A missing or zero base is a first write and is allowed: nothing to lose on a fresh
     * install, and it keeps the endpoint drivable from `curl`.
     */
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      const base = Number(body.baseUpdatedAt) || 0
      return serialise(async () => {
        const current = await readState()
        if (base && current.updatedAt !== base) return send(res, 409, current)
        return send(res, 200, await writeState(body))
      })
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const shown = await present(await harnessOpenThread(harness, ref))
      return send(res, shown.ok ? 200 : 400, shown)
    }

    if ((url.pathname === '/api/new-session' || url.pathname === '/api/reveal') && req.method === 'POST') {
      const { folder, harness } = await readJsonBody(req)
      const dir = await resolveFolder(folder)
      if (!dir) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })

      if (url.pathname === '/api/reveal') {
        launch(dir)
        return send(res, 200, { ok: true })
      }
      const shown = await present(await harnessNewSession(harness || (await defaultHarness()), dir))
      return send(res, shown.ok ? 200 : 400, shown)
    }

    return send(res, 404, { error: 'Unknown endpoint' })
  } catch (err) {
    return send(res, 500, { error: String(err && err.message ? err.message : err) })
  }
}
