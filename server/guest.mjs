/**
 * The guest API: what a neighbour on the LAN is allowed to see, and the whole of it.
 *
 * A second, separate HTTP server, opened only while sharing is on. Read-only is not a
 * permission check here — it is the shape of the socket. The routes are `/guest/info` and
 * `/guest/threads`, both GET; open, archive, new-session and the colony file simply do not
 * exist on this listener, so there is nothing for a hostile LAN peer to even probe. The
 * owner's own UI keeps living on 127.0.0.1, unreachable from outside.
 *
 * What leaves through here is also stripped: `ref` carries harness session ids and `canOpen`
 * invites a click, and a guest can use neither. Everything else on a thread — title, project,
 * status, timestamps — is exactly what the owner sees, which is what "visiting a colony"
 * means.
 */
import http from 'node:http'

export const GUEST_PORT = Number(process.env.BOT_CROSSING_GUEST_PORT) || 5275

/** A thread as a guest may see it: nothing actionable, nothing that names a local file. */
export function guestThread(thread) {
  const { ref, transcriptFile, ...rest } = thread
  return { ...rest, canOpen: false }
}

/**
 * A socket address as a bare IPv4/IPv6 string, comparable to what a neighbour is added as.
 * Node reports IPv4 clients over a dual-stack socket as `::ffff:192.168.0.5`, so the mapping
 * prefix is stripped; loopback arrives as `::1` or `127.0.0.1`.
 */
export function normalizeIp(addr) {
  if (!addr) return ''
  let ip = String(addr)
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  return ip
}

const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.')

/**
 * May this address read the colony? Loopback always (local page, tests), otherwise only the
 * hosts the owner has added as neighbours — so "shared" means "shared with the colleagues I
 * chose", not "readable by the whole LAN". Hosts added by name rather than IP will not match a
 * raw address; discovery adds by IP, which is the path that matters.
 */
export function hostAllowed(remoteAddr, allowedHosts) {
  const ip = normalizeIp(remoteAddr)
  if (!ip) return false
  if (isLoopback(ip)) return true
  return (allowedHosts || []).some((h) => normalizeIp(h) === ip)
}

export class GuestServer {
  /**
   * @param getName    () → the colony's display name, read fresh per request so a rename
   *                   never needs a listener restart.
   * @param getThreads async () → the same scan the owner's page gets.
   * @param getAllowedHosts () → the IPs allowed to read this colony: the hosts of the
   *                   neighbours the owner has added. Loopback is always allowed. Read fresh
   *                   per request, so adding a colleague takes effect without a restart.
   */
  constructor({ port = GUEST_PORT, instanceId, version = '', getName, getThreads, getAllowedHosts }) {
    this.port = port
    this.instanceId = instanceId
    this.version = version
    this.getName = getName
    this.getThreads = getThreads
    this.getAllowedHosts = getAllowedHosts || (() => [])
    this._server = null
    /** True between start() and stop(): the listener is *meant* to be up, so heal it if it dies. */
    this._wantOn = false
    this._healTimer = null
  }

  get running() {
    return Boolean(this._server && this._server.listening)
  }

  start() {
    this._wantOn = true
    if (this._server) return
    const server = http.createServer((req, res) => this._handle(req, res))
    server.on('error', () => {
      // A dead listener must not take the colony down — but it must not stay dead either.
      // Sleep, a network change or a transient bind failure can drop it, and before this the
      // only cure was the owner toggling sharing off and on. Now it heals itself.
      if (this._server === server) this._server = null
      this._scheduleHeal()
    })
    server.on('close', () => {
      if (this._server === server) this._server = null
      if (this._wantOn) this._scheduleHeal()
    })
    server.listen(this.port, '0.0.0.0')
    this._server = server
  }

  /** Bring the listener back a moment after it dropped, as long as it is still meant to be up. */
  _scheduleHeal() {
    if (!this._wantOn || this._healTimer) return
    this._healTimer = setTimeout(() => {
      this._healTimer = null
      if (this._wantOn && !this._server) this.start()
    }, 3000)
    this._healTimer.unref?.()
  }

  /** True while sharing is meant to be on but the socket is not currently listening. */
  get needsHeal() {
    return this._wantOn && !this.running
  }

  stop() {
    this._wantOn = false
    clearTimeout(this._healTimer)
    this._healTimer = null
    this._server?.close()
    this._server = null
  }

  async _handle(req, res) {
    const send = (status, body) => {
      const json = JSON.stringify(body)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(json)
    }
    // Who is asking, before what they asked. A host that is not a configured neighbour gets
    // 403 and never learns whether anything is shared — the allowlist is not even consulted.
    if (!hostAllowed(req.socket?.remoteAddress, this.getAllowedHosts())) {
      return send(403, { error: 'This colony only answers colleagues it has added' })
    }
    if (req.method !== 'GET') return send(405, { error: 'The guest API is read-only' })
    const url = new URL(req.url, 'http://guest')

    try {
      if (url.pathname === '/guest/info') {
        return send(200, {
          app: 'bot-crossing',
          v: 1,
          name: this.getName(),
          version: this.version,
          instanceId: this.instanceId,
        })
      }
      if (url.pathname === '/guest/threads') {
        const threads = await this.getThreads()
        return send(200, { name: this.getName(), threads: threads.map(guestThread), scannedAt: Date.now() })
      }
      return send(404, { error: 'Not found' })
    } catch (err) {
      return send(500, { error: String(err && err.message ? err.message : err) })
    }
  }
}
