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

export class GuestServer {
  /**
   * @param getName    () → the colony's display name, read fresh per request so a rename
   *                   never needs a listener restart.
   * @param getThreads async () → the same scan the owner's page gets.
   */
  constructor({ port = GUEST_PORT, instanceId, version = '', getName, getThreads }) {
    this.port = port
    this.instanceId = instanceId
    this.version = version
    this.getName = getName
    this.getThreads = getThreads
    this._server = null
  }

  get running() {
    return Boolean(this._server)
  }

  start() {
    if (this._server) return
    const server = http.createServer((req, res) => this._handle(req, res))
    server.on('error', () => {
      // The port being taken (a second instance, another app) must not take the colony down;
      // sharing is just off until the owner toggles it again.
      if (this._server === server) this._server = null
    })
    server.listen(this.port, '0.0.0.0')
    this._server = server
  }

  stop() {
    this._server?.close()
    this._server = null
  }

  async _handle(req, res) {
    const send = (status, body) => {
      const json = JSON.stringify(body)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(json)
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
