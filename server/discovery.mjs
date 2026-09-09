/**
 * Finding each other on the LAN: a UDP heartbeat, nothing more.
 *
 * Every instance listens; only an instance whose owner turned sharing on speaks. An
 * announcement is one small JSON datagram to the broadcast address, repeated every
 * ANNOUNCE_MS, saying "a Bot Crossing named X answers guests on port Y here". Listeners
 * collect them into a peers list that expires quietly — three missed heartbeats and you are
 * no longer on it.
 *
 * Broadcast does not cross subnets, and that is accepted rather than fought: mDNS proper
 * would buy multi-subnet discovery at the cost of a dependency and a protocol, and the
 * neighbour you cannot discover can always be added by hand. This file is the "it just shows
 * up" half of that pair, not a guarantee.
 *
 * Own announcements come back on the same socket (broadcast is broadcast) and are recognised
 * by `instanceId` — random per boot — rather than by address, because "which of my addresses
 * did this arrive from" is exactly the kind of question with six wrong answers.
 */
import dgram from 'node:dgram'
import crypto from 'node:crypto'

export const DISCOVERY_PORT = Number(process.env.BOT_CROSSING_DISCOVERY_PORT) || 5276
const ANNOUNCE_MS = 15 * 1000
const PEER_TTL_MS = 50 * 1000

/** One id per boot, shared by discovery and the guest API so a peer can be matched to itself. */
export const INSTANCE_ID = crypto.randomUUID()

export class Discovery {
  constructor({ port = DISCOVERY_PORT, instanceId = INSTANCE_ID } = {}) {
    this.port = port
    this.instanceId = instanceId
    /** host → { name, host, guestPort, lastSeen } */
    this._peers = new Map()
    this._socket = null
    this._announcer = null
    this._announce = null
  }

  /**
   * Start collecting announcements. Safe to call on a machine where another instance holds
   * the port already (the end-to-end test runs two on one box): `reuseAddr` lets both bind,
   * and where the OS still refuses, discovery is simply absent — manual adding still works,
   * so this never takes the server down.
   */
  /** True when the listening socket is up. The reconcile tick rebinds it if it ever drops. */
  get healthy() {
    return Boolean(this._socket)
  }

  listen() {
    if (this._socket) return
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', () => {
      // Sleep or a network change can drop the socket. Null it so the next reconcile rebinds,
      // rather than leaving discovery silently dead until the app restarts.
      try {
        socket.close()
      } catch {
        /* already closing */
      }
      if (this._socket === socket) this._socket = null
    })
    socket.on('message', (buf, rinfo) => this._onMessage(buf, rinfo))
    socket.bind(this.port, () => {
      try {
        socket.setBroadcast(true)
      } catch {
        /* sending is optional; listening already works */
      }
    })
    this._socket = socket
  }

  _onMessage(buf, rinfo) {
    let msg
    try {
      msg = JSON.parse(buf.toString('utf8'))
    } catch {
      return
    }
    if (!msg || msg.app !== 'bot-crossing' || msg.v !== 1) return
    if (msg.instanceId === this.instanceId) return // our own echo
    const guestPort = Number(msg.guestPort)
    if (!Number.isInteger(guestPort) || guestPort <= 0 || guestPort > 65535) return
    const name = String(msg.name || '').slice(0, 80).trim()
    if (!name) return
    this._peers.set(`${rinfo.address}:${guestPort}`, {
      name,
      host: rinfo.address,
      guestPort,
      lastSeen: Date.now(),
    })
  }

  /** Everybody heard from recently. Expiry happens on read — nothing to tick over. */
  peers() {
    const now = Date.now()
    const out = []
    for (const [key, peer] of this._peers) {
      if (now - peer.lastSeen > PEER_TTL_MS) this._peers.delete(key)
      else out.push(peer)
    }
    return out
  }

  /** Start or stop announcing. Called whenever the owner toggles sharing or renames. */
  setAnnounce(enabled, { name, guestPort } = {}) {
    clearInterval(this._announcer)
    this._announcer = null
    this._announce = null
    if (!enabled) return
    this._announce = JSON.stringify({
      v: 1,
      app: 'bot-crossing',
      name: String(name || 'colony').slice(0, 80),
      guestPort,
      instanceId: this.instanceId,
    })
    const beat = () => this._send()
    this._announcer = setInterval(beat, ANNOUNCE_MS)
    // Unref'd so a test that forgets to stop announcing still lets the process exit.
    this._announcer.unref?.()
    beat() // the first heartbeat should not wait 15 seconds
  }

  _send() {
    if (!this._socket || !this._announce) return
    const buf = Buffer.from(this._announce, 'utf8')
    this._socket.send(buf, 0, buf.length, this.port, '255.255.255.255', () => {})
  }

  close() {
    this.setAnnounce(false)
    this._socket?.close()
    this._socket = null
  }
}
