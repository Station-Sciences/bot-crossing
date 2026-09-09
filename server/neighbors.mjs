/**
 * The visiting half: fetch a neighbour's guest API and fold their threads into ours.
 *
 * The owner's own map must never wait on somebody else's machine, so this is built around a
 * cache. `/api/threads` merges whatever each neighbour answered *last time* and kicks off a
 * refresh in the background; a neighbour that is slow, asleep or unplugged costs nothing but
 * a stale district and an `online: false` flag. The page decides what offline looks like.
 *
 * Tagging is where collisions go to die. A guest thread's id is prefixed with the neighbour's
 * address, so two machines that both know a repo called `wra` — or that both scanned the very
 * same session id — can never merge into one astronaut. The project is prefixed with the
 * colony's display name for the same reason, and because the plot label that falls out of it
 * ("Chantal · wra") is exactly the sign the district needed anyway.
 */

const FETCH_TIMEOUT_MS = 2000
/** How long a cached answer is considered fresh enough not to re-ask. */
const REFRESH_MS = 10 * 1000
/** Announce a neighbour as offline only after this long without a good answer. */
const OFFLINE_MS = 45 * 1000

const keyOf = (n) => `${n.host}:${n.port}`

/** A configured neighbour as the colony file is allowed to describe one. */
export function cleanNeighbor(raw) {
  const host = String(raw?.host || '').trim()
  const port = Number(raw?.port) || 0
  if (!host || !/^[\w.:\-]+$/.test(host)) return null
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { name: String(raw?.name || host).slice(0, 80), host, port }
}

export class Neighbors {
  constructor() {
    this.configured = []
    /** key → { threads, name, fetchedAt, okAt, inflight } */
    this._cache = new Map()
  }

  setConfigured(list) {
    this.configured = (Array.isArray(list) ? list : []).map(cleanNeighbor).filter(Boolean)
    const keep = new Set(this.configured.map(keyOf))
    for (const key of this._cache.keys()) if (!keep.has(key)) this._cache.delete(key)
  }

  /** Kick stale entries into refreshing. Returns nothing; the merge reads the cache. */
  refresh() {
    const now = Date.now()
    for (const neighbor of this.configured) {
      const key = keyOf(neighbor)
      const entry = this._cache.get(key) || { threads: [], name: neighbor.name, fetchedAt: 0, okAt: 0 }
      this._cache.set(key, entry)
      if (entry.inflight || now - entry.fetchedAt < REFRESH_MS) continue
      entry.inflight = true
      entry.fetchedAt = now
      this._fetch(neighbor, entry).finally(() => {
        entry.inflight = false
      })
    }
  }

  async _fetch(neighbor, entry) {
    try {
      const res = await fetch(`http://${neighbor.host}:${neighbor.port}/guest/threads`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) return
      const body = await res.json()
      if (!Array.isArray(body?.threads)) return
      entry.threads = body.threads
      // The neighbour knows its own name best — a rename on her side lands here on its own.
      entry.name = String(body.name || neighbor.name).slice(0, 80)
      entry.okAt = Date.now()
    } catch {
      /* offline, slow, or not a guest API — the cache and the okAt stamp already say so */
    }
  }

  /**
   * Everything the neighbours contribute right now: their threads, tagged beyond any chance
   * of colliding with a local id or plot, and a per-colony roster the page uses for banners
   * and the settings list.
   */
  merged() {
    const now = Date.now()
    const threads = []
    const colonies = []
    for (const neighbor of this.configured) {
      const key = keyOf(neighbor)
      const entry = this._cache.get(key)
      const name = entry?.name || neighbor.name
      const online = Boolean(entry && now - entry.okAt < OFFLINE_MS)
      colonies.push({ key, name, host: neighbor.host, port: neighbor.port, online })
      for (const t of entry?.threads || []) {
        threads.push({
          ...t,
          id: `guest:${key}:${t.id}`,
          project: `${name} · ${t.project || 'unknown'}`,
          colony: name,
          colonyKey: key,
          colonyOnline: online,
          canOpen: false,
          ref: undefined,
        })
      }
    }
    return { threads, colonies }
  }
}
