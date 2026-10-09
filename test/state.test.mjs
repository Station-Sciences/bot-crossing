/**
 * The colony file: migration, and the merge that stops two tabs eating each other.
 *
 * These are the pieces where a mistake loses somebody's archive list silently, which is why they
 * were made pure and testable rather than left inline.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mergeState } from '../src/game/merge-state.js'
import { withServer } from './support/with-server.mjs'

// ── the three-way merge ───────────────────────────────────────────────────────

test('an addition from each tab survives the merge', () => {
  const out = mergeState({ archived: ['a'] }, { archived: ['a', 'mine'] }, { archived: ['a', 'theirs'] })
  assert.deepEqual(out.archived.sort(), ['a', 'mine', 'theirs'])
})

test('a removal survives the merge — a plain union would resurrect it', () => {
  const out = mergeState({ archived: ['t1'] }, { archived: [] }, { archived: ['t1', 't2'] })
  assert.deepEqual(out.archived, ['t2'])
})

test('two tabs moving different zones both keep their move', () => {
  const out = mergeState(
    { plots: { a: [[0, 0]], b: [[1, 1]] } },
    { plots: { a: [[9, 9]], b: [[1, 1]] } },
    { plots: { a: [[0, 0]], b: [[7, 7]] } }
  )
  assert.deepEqual(out.plots, { a: [[9, 9]], b: [[7, 7]] })
})

test('a zone this tab never touched is left exactly as the other tab left it', () => {
  // Rebuilt-but-identical arrays must not read as "changed here" — that is what would let a
  // stale copy paste back over a zone somebody else moved.
  const out = mergeState({ plots: { a: [[0, 0]] } }, { plots: { a: [[0, 0]] } }, { plots: { a: [[4, 4]] } })
  assert.deepEqual(out.plots, { a: [[4, 4]] })
})

test('hiding a repo survives a conflicting save', () => {
  assert.deepEqual(mergeState({ hiddenProjects: [] }, { hiddenProjects: ['x'] }, { hiddenProjects: [] }).hiddenProjects, ['x'])
  assert.deepEqual(mergeState({ hiddenProjects: [] }, { hiddenProjects: [] }, { hiddenProjects: ['y'] }).hiddenProjects, ['y'])
})

test('settings are not merged field-wise — the last tab to touch a slider wins whole', () => {
  const out = mergeState({ settings: { q: 1 } }, { settings: { q: 3 } }, { settings: { q: 2, planet: 'mars' } })
  assert.deepEqual(out.settings, { q: 3 })
})

// ── the API, against a real socket ────────────────────────────────────────────

// ── the save gate ─────────────────────────────────────────────────────────────

/**
 * The page boots holding an empty archive list and only swaps it for the real one when the
 * read resolves. A save inside that window PUTs the empty list, and the server allows it: the
 * base is still 0, which it reads as a first write. Nothing else catches this — the wipe even
 * hides itself afterwards, because the scan carries each harness's own archived flag and a
 * wiped file reads back populated.
 *
 * So the refusal has to happen before the request leaves, which is what this asserts: not that
 * the save fails, but that nothing was sent at all.
 */
test('a colony that was never read is not saved — the request never leaves', async () => {
  const { saveState } = await import('../src/game/api.js')
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (...args) => {
    calls++
    return realFetch(...args)
  }
  try {
    await assert.rejects(() => saveState({ archived: [] }), /never read/)
    assert.equal(calls, 0, 'a colony that was never read must not reach the network')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a v1 file has its bare ids prefixed on read, once', async () => {
  await withServer(async ({ call, dir }) => {
    const id = 'fe911daa-2393-4e29-8d36-6e37c328594c'
    await fsp.writeFile(
      path.join(dir, 'colony.json'),
      JSON.stringify({ version: 1, archived: [id], archivedAt: { [id]: 5 }, updatedAt: 1 })
    )
    const state = await (await call('/api/state')).json()
    assert.equal(state.version, 2)
    assert.deepEqual(state.archived, [`claude-code:${id}`])
    assert.deepEqual(Object.keys(state.archivedAt), [`claude-code:${id}`])
  })
})

test('a stale save is refused with the disk state, not silently applied', async () => {
  await withServer(async ({ call, put }) => {
    const seed = await (await put({ archived: ['seed'] })).json()
    assert.equal((await put({ archived: ['ok'], baseUpdatedAt: seed.updatedAt })).status, 200)
    const stale = await put({ archived: ['lost'], baseUpdatedAt: seed.updatedAt })
    assert.equal(stale.status, 409)
    assert.deepEqual((await stale.json()).archived, ['ok'])
    void call
  })
})

test('a save with no base is allowed, so curl and a fresh install both work', async () => {
  await withServer(async ({ put }) => {
    assert.equal((await put({ archived: ['first'] })).status, 200)
  })
})

test('simultaneous saves never 500 — one wins, the rest get a mergeable 409', async () => {
  await withServer(async ({ call, put }) => {
    const seed = await (await put({ archived: ['seed'] })).json()
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => put({ archived: [`t${i}`], baseUpdatedAt: seed.updatedAt }))
    )
    const codes = results.map((r) => r.status)
    assert.equal(codes.filter((c) => c === 200).length, 1, 'exactly one writer wins')
    assert.equal(codes.filter((c) => c === 409).length, 4, 'the rest are told to merge')
    assert.ok(!codes.some((c) => c >= 500), `no crashes, got ${codes}`)
    void call
  })
})

test('archiving is not a server endpoint any more — the colony owns that list', async () => {
  await withServer(async ({ call }) => {
    const res = await call('/api/archive', { method: 'POST', body: JSON.stringify({ id: 'x' }) })
    assert.equal(res.status, 404)
  })
})

test('a cross-origin write is refused even though the host is local', async () => {
  await withServer(async ({ call }) => {
    const res = await fetch(new URL('/api/state', `http://127.0.0.1:0`), { method: 'PUT' }).catch(() => null)
    void res
    const bad = await call('/api/state', { method: 'PUT', body: '{}', headers: { Origin: 'http://evil.com' } })
    assert.equal(bad.status, 403)
  })
})

// ── marking a thread viewed ───────────────────────────────────────────────────

/**
 * The rule `applyThreads` uses. Kept here as well because it is one line in the browser and
 * the whole point of it is the *second* half: viewed is a timestamp, not a flag, so a thread
 * that moves on afterwards starts asking again.
 */
const suppressUnread = (thread, viewedAt) => {
  const at = viewedAt[thread.id]
  return at && thread.lastActivityAt <= at ? { ...thread, unread: false } : thread
}

test('marking a thread viewed stops it asking', () => {
  const t = { id: 'a', unread: true, lastActivityAt: 100 }
  assert.equal(suppressUnread(t, { a: 200 }).unread, false)
})

test('a thread that moves on after you looked asks again', () => {
  const t = { id: 'a', unread: true, lastActivityAt: 300 }
  assert.equal(suppressUnread(t, { a: 200 }).unread, true, 'newer activity beats an older look')
})

test('viewing one thread says nothing about another', () => {
  const t = { id: 'b', unread: true, lastActivityAt: 100 }
  assert.equal(suppressUnread(t, { a: 200 }).unread, true)
})

test('viewedAt survives a merge, so a second tab cannot un-view a thread', () => {
  const merged = mergeState({ viewedAt: {} }, { viewedAt: { a: 5 } }, { viewedAt: { b: 7 } })
  assert.deepEqual(merged.viewedAt, { a: 5, b: 7 })
})

test('viewedAt is carried through the v1 migration with the ids it keys on', async () => {
  await withServer(async ({ call, dir }) => {
    const id = 'fe911daa-2393-4e29-8d36-6e37c328594c'
    await fsp.writeFile(
      path.join(dir, 'colony.json'),
      JSON.stringify({ version: 1, viewedAt: { [id]: 42 }, updatedAt: 1 })
    )
    const state = await (await call('/api/state')).json()
    assert.deepEqual(Object.keys(state.viewedAt), [`claude-code:${id}`])
  })
})

// ── neighbors ────────────────────────────────────────────────────────────────

test('sharing and neighbors round-trip through the colony file', async () => {
  await withServer(async ({ call, put }) => {
    const sharing = { enabled: true, key: 'a'.repeat(32), name: 'Mark' }
    const neighbors = [{ id: 'nb_1', url: 'http://192.168.1.9:5275', key: 'b'.repeat(32), slot: 0, addedAt: 5 }]
    assert.equal((await put({ sharing, neighbors })).status, 200)
    const state = await (await call('/api/state')).json()
    assert.deepEqual(state.sharing, sharing)
    assert.deepEqual(state.neighbors, neighbors)
  })
})

test('a fresh colony is not sharing and has no neighbors', async () => {
  await withServer(async ({ call }) => {
    const state = await (await call('/api/state')).json()
    assert.deepEqual(state.sharing, { enabled: false, key: '', name: '' })
    assert.deepEqual(state.neighbors, [])
  })
})

test('junk neighbor entries are dropped and the list is capped at six', async () => {
  await withServer(async ({ call, put }) => {
    const ok = (i) => ({ id: `nb_${i}`, url: `http://10.0.0.${i}:5275`, key: 'c'.repeat(32), slot: i, addedAt: 1 })
    await put({ neighbors: [null, { id: 3 }, ...[0, 1, 2, 3, 4, 5, 6].map(ok)] })
    const state = await (await call('/api/state')).json()
    assert.equal(state.neighbors.length, 6)
    assert.equal(state.neighbors[0].id, 'nb_0')
  })
})

test('sharing merges whole: whichever tab changed it wins', () => {
  const base = { sharing: { enabled: false, key: '', name: '' } }
  const mine = { sharing: { enabled: true, key: 'k'.repeat(32), name: 'Me' } }
  assert.deepEqual(mergeState(base, mine, base).sharing, mine.sharing)
  assert.deepEqual(mergeState(base, base, mine).sharing, mine.sharing)
})

test('neighbors merge by id: an add in each tab survives, a removal stays removed', () => {
  const a = { id: 'nb_a', url: 'http://a', key: '', slot: 0, addedAt: 1 }
  const b = { id: 'nb_b', url: 'http://b', key: '', slot: 1, addedAt: 2 }
  const c = { id: 'nb_c', url: 'http://c', key: '', slot: 2, addedAt: 3 }
  const out = mergeState({ neighbors: [a] }, { neighbors: [a, b] }, { neighbors: [a, c] })
  assert.deepEqual(out.neighbors.map((n) => n.id), ['nb_a', 'nb_b', 'nb_c'])
  const removed = mergeState({ neighbors: [a, b] }, { neighbors: [b] }, { neighbors: [a, b] })
  assert.deepEqual(removed.neighbors.map((n) => n.id), ['nb_b'])
})

// ── war ──────────────────────────────────────────────────────────────────────

const WAR_BATTLE = { id: 'war_k_1', target: 'a'.repeat(16), seed: 9, startedAt: 1, attackers: 4, defenders: 5, targetNeighborId: 'nb_1' }

test('war round-trips through the colony file', async () => {
  await withServer(async ({ call, put }) => {
    const war = { enabled: true, battle: WAR_BATTLE, tally: { nb_1: { won: 2, lost: 1 } }, seen: ['war_k_0'], busyUntil: 123456 }
    assert.equal((await put({ war })).status, 200)
    const state = await (await call('/api/state')).json()
    assert.deepEqual(state.war, war)
  })
})

test('a fresh colony is at peace', async () => {
  await withServer(async ({ call }) => {
    const state = await (await call('/api/state')).json()
    assert.deepEqual(state.war, { enabled: false, battle: null, tally: {}, seen: [], busyUntil: 0 })
  })
})

test('junk war entries are dropped and seen is capped at fifty', async () => {
  await withServer(async ({ call, put }) => {
    const seen = Array.from({ length: 60 }, (_, i) => `war_x_${i}`)
    await put({ war: {
      enabled: 'yes',
      battle: { ...WAR_BATTLE, attackers: 0 },
      tally: { nb_1: { won: 3, lost: 'x' }, nb_2: null, nb_3: { won: -1, lost: 2 } },
      seen: [...seen, 5, null],
      busyUntil: 'later',
    } })
    const { war } = await (await call('/api/state')).json()
    assert.equal(war.enabled, false)
    assert.equal(war.battle, null)
    assert.deepEqual(war.tally, { nb_1: { won: 3, lost: 0 }, nb_3: { won: 0, lost: 2 } })
    assert.deepEqual(war.seen, seen.slice(0, 50))
    assert.equal(war.busyUntil, 0)
  })
})

test('war merges whole: whichever tab changed it wins', () => {
  const peace = { enabled: false, battle: null, tally: {}, seen: [], busyUntil: 0 }
  const mine = { ...peace, enabled: true, busyUntil: 99 }
  assert.deepEqual(mergeState({ war: peace }, { war: mine }, { war: peace }).war, mine)
  assert.deepEqual(mergeState({ war: peace }, { war: peace }, { war: mine }).war, mine)
})
