// server/neighbors.mjs
/**
 * Fetching friends' colonies, server side, so the page never talks to another machine.
 *
 * Everything that arrives here is untrusted: `validateSnapshot` is the only way a snapshot gets
 * in, and it rebuilds one field by field from a fixed shape with every string capped. A friend's
 * machine can be off, slow, on another version, or simply wrong, and each of those reads as a
 * status the settings row can show rather than as an error the poll has to survive.
 */
import { SHARE_PATH } from './share.mjs'
import { cleanBattle } from '../src/game/war.js'

const MAX_PROJECTS = 200
const MAX_THREADS = 500
const MAX_STRING = 120
const MAX_CELLS = 64
const MAX_BODY = 2_000_000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const SHARED_ID = /^n:[0-9a-f]{16}$/
const WORD = /^[A-Za-z]{0,12}$/

// eslint-disable-next-line no-control-regex
const str = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_STRING)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

function cleanCells(cells) {
  if (!Array.isArray(cells)) return []
  return cells
    .filter((c) => Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]) && Math.abs(c[0]) < 1000 && Math.abs(c[1]) < 1000)
    .slice(0, MAX_CELLS)
    .map(([q, r]) => [q, r])
}

export function validateSnapshot(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'malformed' }
  if (json.v !== 1) return { ok: false, reason: 'needs-update' }
  if (!Array.isArray(json.projects) || !Array.isArray(json.threads)) return { ok: false, reason: 'malformed' }
  if (json.projects.length > MAX_PROJECTS || json.threads.length > MAX_THREADS) return { ok: false, reason: 'malformed' }

  const projects = []
  const names = new Set()
  for (const p of json.projects) {
    const name = str(p?.name)
    if (!name || names.has(name)) continue
    names.add(name)
    projects.push({ name, cells: cleanCells(p.cells) })
  }

  const threads = []
  for (const t of json.threads) {
    if (!t || typeof t !== 'object') continue
    const id = str(t.id)
    const project = str(t.project)
    if (!SHARED_ID.test(id) || !names.has(project)) continue
    const pr = String(t.prState ?? '')
    threads.push({
      id,
      project,
      harness: str(t.harness),
      harnessName: str(t.harnessName),
      running: t.running === true,
      unread: t.unread === true,
      hasError: t.hasError === true,
      prState: WORD.test(pr) ? pr : '',
      lastActivityAt: num(t.lastActivityAt),
      createdAt: num(t.createdAt),
      sizeBucket: Math.max(0, Math.min(40, Math.floor(num(t.sizeBucket)))),
      isErrand: t.isErrand === true,
    })
  }

  return {
    ok: true,
    snapshot: { v: 1, name: str(json.name).slice(0, 40) || 'Neighbor', generatedAt: num(json.generatedAt),
      warReady: json.warReady === true, warBusy: json.warBusy === true, battle: cleanBattle(json.battle), projects, threads },
  }
}

/**
 * The body as text, or null once it passes `max` bytes. Read as a stream and cut off there, so a
 * friend who sends forever costs us `max` bytes rather than everything until the timeout.
 */
async function readCapped(res, max) {
  if (Number(res.headers.get('content-length')) > max) {
    res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createNeighborFetcher({ fetchImpl = globalThis.fetch, timeoutMs = 2000, now = Date.now } = {}) {
  /** id → { snapshot, lastSeenAt }: the last time each friend answered properly. */
  const cache = new Map()

  async function one(n) {
    const known = cache.get(n.id)
    /** A failure keeps whatever we last had, unless that is more than a week old. */
    const keep = (status) => {
      const fresh = known && now() - known.lastSeenAt <= WEEK_MS
      return {
        id: n.id,
        status: !known && status === 'away' ? 'unreachable' : status,
        lastSeenAt: known?.lastSeenAt ?? 0,
        snapshot: fresh ? known.snapshot : null,
      }
    }

    let url
    try {
      url = new URL(SHARE_PATH, n.url)
    } catch {
      return keep('away')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return keep('away')

    let res
    try {
      // Never follow a redirect: a friend could point us at our own /api/neighbors, which a
      // server-side fetch passes as local, and the two would call each other until one fell over.
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${n.key}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return keep('away')
    }
    if (res.status === 401) return keep('bad-key')
    if (!res.ok) return keep('away') // 3xx included, and the opaque redirect a browser-style fetch gives back

    let json
    try {
      const text = await readCapped(res, MAX_BODY)
      if (text === null) return keep('away')
      json = JSON.parse(text)
    } catch {
      return keep('away')
    }
    const checked = validateSnapshot(json)
    if (!checked.ok) return keep(checked.reason === 'needs-update' ? 'needs-update' : 'away')

    const at = now()
    cache.set(n.id, { snapshot: checked.snapshot, lastSeenAt: at })
    return { id: n.id, status: 'online', lastSeenAt: at, snapshot: checked.snapshot }
  }

  return {
    async refresh(neighbors) {
      const ids = new Set(neighbors.map((n) => n.id))
      for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id) // removed friends are forgotten
      return Promise.all(neighbors.map(one))
    },
  }
}
