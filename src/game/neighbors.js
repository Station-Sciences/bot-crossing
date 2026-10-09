/**
 * Friends, on the page side: share links, the friends list, and turning what the server fetched
 * into threads the colony can draw.
 *
 * Pure and browser-free so it runs under bare node, like merge-state.js and errands.js.
 */

export const NEIGHBOR_CAP = 6
const KEY_HEX = /^[0-9a-f]{32}$/

/** 128 random bits as hex. The browser makes the key; the server only ever reads it. */
export function newShareKey(bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The key rides in the fragment, so a link pasted into a browser by mistake never sends it. */
export function shareLink({ lanAddress, port, key }) {
  return lanAddress && port && key ? `http://${lanAddress}:${port}/#k=${key}` : ''
}

export function parseShareLink(text) {
  let url
  try {
    url = new URL(String(text || '').trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const key = new URLSearchParams(url.hash.replace(/^#/, '')).get('k') || ''
  return KEY_HEX.test(key) ? { url: url.origin, key } : null
}

/** Lowest free slot, so a friend added after a removal fills the side that came free. */
export function addNeighbor(list, text, { now = Date.now() } = {}) {
  const parsed = parseShareLink(text)
  if (!parsed) return { list, error: 'That does not look like a Bot Crossing share link' }
  if (list.length >= NEIGHBOR_CAP) return { list, error: 'Six neighbors is the most there is room for' }
  if (list.some((n) => n.url === parsed.url)) return { list, error: 'Already a neighbor' }
  const taken = new Set(list.map((n) => n.slot))
  let slot = 0
  while (taken.has(slot)) slot++
  const entry = { id: `nb_${now.toString(36)}`, url: parsed.url, key: parsed.key, slot, addedAt: now }
  return { list: [...list, entry], entry, error: '' }
}

export function removeNeighbor(list, id) {
  return list.filter((n) => n.id !== id)
}

export const neighborThreadId = (neighborId, sharedId) => `nb:${neighborId}:${sharedId}`

/**
 * Snapshot threads → colony threads. A friend who is not online right now keeps their buildings
 * but every bot sits down: nothing running, nothing waiting, last active at the epoch — which
 * `statusFor` reads as asleep. Their errands go, because an errand is by definition running.
 */
export function hydrateNeighbors(saved, results) {
  const byId = new Map((results || []).map((r) => [r.id, r]))
  const out = []
  for (const n of saved || []) {
    const r = byId.get(n.id)
    if (!r?.snapshot) continue
    const online = r.status === 'online'
    const name = r.snapshot.name || 'Neighbor'
    const who = { id: n.id, name }
    out.push({
      id: n.id,
      slot: n.slot,
      name,
      online,
      status: r.status,
      lastSeenAt: r.lastSeenAt,
      projects: r.snapshot.projects,
      threads: r.snapshot.threads
        .filter((t) => online || !t.isErrand)
        .map((t) => ({
          id: neighborThreadId(n.id, t.id),
          title: t.project,
          preview: '',
          project: t.project,
          harness: t.harness,
          harnessName: t.harnessName,
          running: online && t.running,
          unread: online && t.unread,
          hasError: online && t.hasError,
          prState: online ? t.prState : '',
          lastActivityAt: online ? t.lastActivityAt : 0,
          createdAt: t.createdAt,
          sizeBytes: 2 ** t.sizeBucket,
          archived: false,
          canOpen: false,
          ref: null,
          neighbor: who,
        })),
    })
  }
  return out
}

function ago(ms) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

/** One line for the settings row and the sidebar. */
export function describeNeighbor(status, lastSeenAt, now = Date.now()) {
  if (status === 'online') return 'here now'
  if (status === 'bad-key') return 'link no longer valid'
  if (status === 'needs-update') return 'needs an update'
  if (status === 'away' && lastSeenAt) return `away · last seen ${ago(now - lastSeenAt)}`
  return 'not reached yet'
}
