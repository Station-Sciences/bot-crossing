import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NEIGHBOR_CAP, NEIGHBOR_THREAD_CAP, addNeighbor, capNeighborThreads, describeNeighbor, hydrateNeighbors, neighborThreadId,
  newShareKey, parseShareLink, removeNeighbor, shareLink,
} from '../src/game/neighbors.js'

test('a share link round-trips', () => {
  const key = newShareKey()
  assert.match(key, /^[0-9a-f]{32}$/)
  const link = shareLink({ lanAddress: '192.168.1.42', port: 5275, key })
  assert.equal(link, `http://192.168.1.42:5275/#k=${key}`)
  assert.deepEqual(parseShareLink(`  ${link}  `), { url: 'http://192.168.1.42:5275', key })
})

test('anything that is not a share link is refused', () => {
  for (const bad of ['', 'hello', 'http://x:5275/', 'http://x:5275/#k=short', `ftp://x/#k=${'a'.repeat(32)}`, `http://x/#k=${'G'.repeat(32)}`]) {
    assert.equal(parseShareLink(bad), null, bad)
  }
})

test('no link without an address, a port and a key', () => {
  assert.equal(shareLink({ lanAddress: '', port: 5275, key: 'k' }), '')
})

test('adding takes the lowest free slot and refuses duplicates and a seventh', () => {
  const link = (i) => `http://10.0.0.${i}:5275/#k=${'a'.repeat(32)}`
  let list = []
  for (let i = 0; i < 3; i++) list = addNeighbor(list, link(i), { now: 1000 + i }).list
  assert.deepEqual(list.map((n) => n.slot), [0, 1, 2])
  list = removeNeighbor(list, list[1].id)
  const next = addNeighbor(list, link(9), { now: 2000 })
  assert.equal(next.entry.slot, 1)
  assert.match(addNeighbor(next.list, link(0), { now: 3000 }).error, /Already/)
  let full = next.list
  for (let i = 10; full.length < NEIGHBOR_CAP; i++) full = addNeighbor(full, link(i), { now: 4000 + i }).list
  assert.match(addNeighbor(full, link(99), { now: 9999 }).error, /Six/)
  assert.match(addNeighbor([], 'nope').error, /share link/)
})

test('re-adding a friend with a new key updates their link in place, even when the list is full', () => {
  const link = (i, k) => `http://10.0.0.${i}:5275/#k=${k.repeat(32)}`
  let list = []
  for (let i = 0; i < NEIGHBOR_CAP; i++) list = addNeighbor(list, link(i, 'a'), { now: 1000 + i }).list
  const before = list[2]
  const out = addNeighbor(list, link(2, 'b'), { now: 9999 })
  assert.equal(out.error, '')
  assert.equal(out.updated, true)
  assert.equal(out.list.length, NEIGHBOR_CAP)
  assert.deepEqual(out.entry, { ...before, key: 'b'.repeat(32) })
  assert.deepEqual(out.list[2], out.entry)
  assert.match(addNeighbor(out.list, link(2, 'b'), { now: 10000 }).error, /Already/)
})

const thread = (n, extra = {}) => ({
  id: `n:000000000000000${n}`, project: 'bot-crossing', harness: 'claude-code', harnessName: 'Claude Code',
  running: true, unread: false, hasError: false, prState: '', lastActivityAt: 5, createdAt: n, sizeBucket: 12, isErrand: false,
  ...extra,
})
const snapshot = {
  v: 1, name: 'Mark', generatedAt: 1,
  projects: [{ name: 'bot-crossing', cells: [[0, 0]] }],
  threads: [thread(1), thread(2, { isErrand: true, sizeBucket: 0 })],
}

test("an online friend's threads come through namespaced and unopenable", () => {
  const [n] = hydrateNeighbors([{ id: 'nb_1', slot: 2 }], [{ id: 'nb_1', status: 'online', lastSeenAt: 9, snapshot }])
  assert.equal(n.slot, 2)
  assert.equal(n.online, true)
  assert.equal(n.threads.length, 2)
  const t = n.threads[0]
  assert.equal(t.id, neighborThreadId('nb_1', 'n:0000000000000001'))
  assert.equal(t.sizeBytes, 4096)
  assert.equal(t.canOpen, false)
  assert.equal(t.running, true)
  assert.deepEqual(t.neighbor, { id: 'nb_1', name: 'Mark' })
})

test("an away friend's bots are all asleep, and their errands are gone", () => {
  const [n] = hydrateNeighbors([{ id: 'nb_1', slot: 0 }], [{ id: 'nb_1', status: 'away', lastSeenAt: 9, snapshot }])
  assert.equal(n.online, false)
  assert.equal(n.threads.length, 1)
  assert.equal(n.threads[0].running, false)
  assert.equal(n.threads[0].lastActivityAt, 0)
})

test('only the most telling of a friend\'s threads are kept, in their own order', () => {
  const now = 10 * 24 * 3600 * 1000
  const list = [
    thread(1, { running: false, lastActivityAt: 0 }), // sleeping
    thread(2, { running: false, lastActivityAt: now - 5000 }), // idle, recent
    thread(3, { running: false, lastActivityAt: now - 9000 }), // idle, older
    thread(4, { running: true }), // working
    thread(5, { running: false, unread: true, lastActivityAt: now }), // waiting
    thread(6, { hasError: true }), // blocked
    thread(7, { running: false, prState: 'MERGED', lastActivityAt: now }), // celebrating
  ]
  const ids = (l) => l.map((t) => t.createdAt)
  assert.deepEqual(ids(capNeighborThreads(list, 3, now)), [4, 5, 6])
  assert.deepEqual(ids(capNeighborThreads(list, 5, now)), [2, 4, 5, 6, 7])
  assert.equal(capNeighborThreads(list, 10, now), list)
})

test('a friend sharing hundreds of threads is drawn with at most the cap', () => {
  const many = Array.from({ length: 300 }, (_, i) => thread(1, { id: `n:${String(i).padStart(16, '0')}` }))
  const [n] = hydrateNeighbors([{ id: 'nb_1', slot: 0 }], [{ id: 'nb_1', status: 'online', lastSeenAt: 9, snapshot: { ...snapshot, threads: many } }])
  assert.equal(n.threads.length, NEIGHBOR_THREAD_CAP)
})

test('a friend with nothing to draw is left out', () => {
  assert.deepEqual(hydrateNeighbors([{ id: 'nb_1', slot: 0 }], [{ id: 'nb_1', status: 'unreachable', lastSeenAt: 0, snapshot: null }]), [])
  assert.deepEqual(hydrateNeighbors([{ id: 'nb_1', slot: 0 }], []), [])
})

test('each status reads as a sentence', () => {
  const now = 10 * 60000
  assert.equal(describeNeighbor('online', now, now), 'here now')
  assert.equal(describeNeighbor('away', now - 12 * 60000, now), 'away · last seen 12m ago')
  assert.equal(describeNeighbor('bad-key', 0, now), 'link no longer valid')
  assert.equal(describeNeighbor('needs-update', 0, now), 'needs an update')
  assert.equal(describeNeighbor('unreachable', 0, now), 'not reached yet')
})

test('war readiness and an announced battle pass through to the page, and default to none', () => {
  const battle = { id: 'war_k_1', target: 'a'.repeat(16), seed: 9, startedAt: 5, attackers: 4, defenders: 5 }
  const [on] = hydrateNeighbors([{ id: 'nb_1', slot: 0 }], [{ id: 'nb_1', status: 'online', lastSeenAt: 9, snapshot: { ...snapshot, warReady: true, battle } }])
  assert.equal(on.warReady, true)
  assert.deepEqual(on.battle, battle)
  const [off] = hydrateNeighbors([{ id: 'nb_1', slot: 0 }], [{ id: 'nb_1', status: 'online', lastSeenAt: 9, snapshot }])
  assert.equal(off.warReady, false)
  assert.equal(off.battle, null)
  assert.equal(off.warBusy, false)
  const [busy] = hydrateNeighbors([{ id: 'nb_1', slot: 0 }], [{ id: 'nb_1', status: 'online', lastSeenAt: 9, snapshot: { ...snapshot, warBusy: true } }])
  assert.equal(busy.warBusy, true)
})
