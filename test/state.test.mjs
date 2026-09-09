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
import http from 'node:http'

import { mergeState } from '../src/game/merge-state.js'

// ── the three-way merge ───────────────────────────────────────────────────────

test('an addition from each tab survives the merge', () => {
  const out = mergeState({ archived: ['a'] }, { archived: ['a', 'mine'] }, { archived: ['a', 'theirs'] })
  assert.deepEqual(out.archived.sort(), ['a', 'mine', 'theirs'])
})

test('a removal survives the merge — a plain union would resurrect it', () => {
  const out = mergeState({ archived: ['t1'] }, { archived: [] }, { archived: ['t1', 't2'] })
  assert.deepEqual(out.archived, ['t2'])
})

test('network config takes the local tab whole, like settings — never half a share toggle', () => {
  const base = { network: { colonyName: 'Dimitri', share: false, neighbors: [] } }
  const local = { network: { colonyName: 'Dimitri', share: true, neighbors: [{ name: 'Chantal', host: 'c-pc', port: 5275 }] } }
  const remote = { network: { colonyName: 'Dimitri', share: false, neighbors: [] } }
  const out = mergeState(base, local, remote)
  assert.equal(out.network.share, true)
  assert.equal(out.network.neighbors.length, 1)
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

async function withServer(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-test-'))
  process.env.BOT_CROSSING_DATA = dir
  // Imported per-server so DATA_DIR is read fresh; the query string defeats the module cache.
  const { apiMiddleware } = await import(`../server/api.mjs?${dir}`)
  const server = http.createServer((req, res) => apiMiddleware(req, res, null))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = (p, opts) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      headers: { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' },
      ...opts,
    })
  try {
    await run({ call, dir, put: (b) => call('/api/state', { method: 'PUT', body: JSON.stringify(b) }) })
  } finally {
    server.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

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
