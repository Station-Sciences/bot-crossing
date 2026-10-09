// server/share.mjs
/**
 * The share port: the one listener in Bot Crossing that answers machines other than this one.
 *
 * A separate `http.Server` with its own handler, not the API middleware behind a different
 * guard — so nothing that can open a thread, start a session or write the colony file is
 * reachable from it, by construction rather than by a check someone could get wrong later.
 * It exists only while sharing is on, and answers exactly one request.
 */
import http from 'node:http'
import crypto from 'node:crypto'

export const SHARE_PATH = '/share/v1/colony'

const RATE_WINDOW_MS = 60_000
const RATE_MAX = 30

/** Constant-time on equal lengths; an empty expected key means sharing has no key, so nobody. */
export function keysMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')
  return m ? m[1] : ''
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

export function createShareService({ host, port, getKey, snapshot }) {
  let server = null
  let status = { listening: false, port: 0, error: '' }
  let chain = Promise.resolve()
  const hits = new Map()

  /** Counted before the key is looked at, so guessing keys is as slow as everything else. */
  function limited(addr) {
    const now = Date.now()
    const h = hits.get(addr)
    if (!h || now - h.start > RATE_WINDOW_MS) {
      hits.set(addr, { start: now, count: 1 })
      return false
    }
    h.count += 1
    return h.count > RATE_MAX
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://share.local')
    if (req.method !== 'GET' || url.pathname !== SHARE_PATH) return send(res, 404, { error: 'Not found' })
    if (limited(req.socket.remoteAddress || '')) return send(res, 429, { error: 'Too many requests' })
    if (!keysMatch(bearer(req), await getKey())) return send(res, 401, { error: 'Wrong or missing key' })
    return send(res, 200, await snapshot())
  }

  function open() {
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch(() => send(res, 500, { error: 'Could not build the colony snapshot' }))
      })
      s.once('error', (err) => {
        status = {
          listening: false,
          port: 0,
          error: err.code === 'EADDRINUSE' ? `Couldn't open port ${port} — something else is using it` : String(err.message || err),
        }
        resolve()
      })
      s.listen(port, host, () => {
        server = s
        status = { listening: true, port: s.address().port, error: '' }
        resolve()
      })
    })
  }

  function shut() {
    if (!server) return Promise.resolve()
    const s = server
    server = null
    status = { listening: false, port: 0, error: '' }
    hits.clear()
    return new Promise((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections?.()
    })
  }

  // Serialised: a toggle flicked twice quickly must not open two listeners on one port.
  const queue = (fn) => (chain = chain.then(fn, fn))

  return {
    sync: (enabled) => queue(() => (enabled ? (server ? undefined : open()) : shut())),
    status: () => ({ ...status }),
    close: () => queue(shut),
  }
}
