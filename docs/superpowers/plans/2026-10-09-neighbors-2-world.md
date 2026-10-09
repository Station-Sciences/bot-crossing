# Neighbors, part 2: the world — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw each friend's colony as a neighbouring settlement — their zones, buildings, ship and bots — beside your own, with a read-only card, a Settings → Neighbors panel, and a Neighbors list in the sidebar.

**Architecture:** Friends' plots go into the existing `Colony` on the same global hex lattice, tagged `plot.neighbor`, shifted out by a pure placement function. Anything about *the ground* (decks, ground height, scatter, grass, islands, navigation, labels) iterates `colony.worldPlots`; anything about *your threads* keeps iterating `colony.plots` / `plotOrder` / `threads`. Bots share the one instanced renderer; a neighbour's bot carries `neighbor` and its own ship's `doors`.

**Tech Stack:** three.js, plain DOM HUD, Vite, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-neighbors-design.md` (§3 was amended while planning: no `Settlement` class — see "Neighbor plots in the one `Colony`").

**Depends on:** `docs/superpowers/plans/2026-10-09-neighbors-1-server.md`, fully landed. This plan consumes `GET /api/sharing`, `GET /api/neighbors` and the `Snapshot` shape defined there.

## Global Constraints

- Everything in Part 1's Global Constraints still holds.
- At most **6** neighbours; slot 0–5 maps to `HEX_DIRS[slot]` (`src/world/plot-move.js`). Gap: at least **2 empty rings** (`hexDistance > 2`) between any neighbour cell and any home cell or other neighbour cell.
- Neighbour plot ids are `nb:<neighborId>/<repo>`; neighbour thread ids are `nb:<neighborId>:<sharedId>`.
- Home bots always outrank neighbour bots for the `maxAgents` display cap.
- Never offered for a neighbour: Open, Viewed, Archive, Hide, New conversation, Finder, Copy path, hold-to-drag (zone or bot), the "waiting" chime, `N` (next waiting), stats counts.
- Home colony behaviour must not change: `test/colony-motion.test.mjs`, `test/plot-move.test.mjs`, `test/picking.test.mjs`, `test/occlusion.test.mjs`, `test/state.test.mjs` pass unchanged.
- `npm test` must show only the two baseline Windows failures listed in Part 1. `npx vite build` must succeed after every task that touches `src/`.

---

### Task 1: Where a neighbour goes

**Files:**
- Create: `src/world/neighbor-layout.js`
- Test: `test/neighbor-layout.test.mjs`

**Interfaces:**
- Consumes: `HEX_DIRS`, `SHIP_CELL`, `cellKey` from `src/world/plot-move.js`.
- Produces:
  - `NEIGHBOR_GAP = 2`, `MAX_NEIGHBORS = 6`
  - `placeNeighbors(home: {q,r}[], neighbors: { id, slot, cells: {q,r}[] }[], previous?: Map<id,{q,r}>, directions?: [dq,dr][]) → Map<id, {q,r}>` — cells are in the neighbour's own frame, ship cell included; the result is the axial offset to add.
  - `landward(seaDir: {x,z}) → [dq,dr][]` — the hex directions pointing away from the sea.

- [ ] **Step 1: Write the failing tests**

```js
// test/neighbor-layout.test.mjs
/**
 * Where a friend's settlement lands. Pure, like plot-move.js, because getting it wrong puts a
 * friend's zones on top of yours — and it is the kind of wrong nobody notices until it happens.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { HEX_DIRS, SHIP_CELL, hexDistance } from '../src/world/plot-move.js'
import { NEIGHBOR_GAP, landward, placeNeighbors } from '../src/world/neighbor-layout.js'

const home = [{ q: 0, r: 0 }, SHIP_CELL]
const small = (id, slot) => ({ id, slot, cells: [{ q: 0, r: 0 }, SHIP_CELL] })
const shifted = (cells, o) => cells.map((c) => ({ q: c.q + o.q, r: c.r + o.r }))
const minGap = (a, b) => Math.min(...a.flatMap((x) => b.map((y) => hexDistance(x, y))))

test("a neighbour lands just past two clear rings, along its slot's direction", () => {
  const out = placeNeighbors(home, [small('a', 0)])
  assert.deepEqual(out.get('a'), { q: 4, r: 0 })
  assert.ok(minGap(home, shifted(small('a', 0).cells, out.get('a'))) > NEIGHBOR_GAP)
})

test('each slot has its own side', () => {
  const out = placeNeighbors(home, [0, 1, 2, 3, 4, 5].map((s) => small(`n${s}`, s)))
  for (let s = 0; s < 6; s++) {
    const o = out.get(`n${s}`)
    const [dq, dr] = HEX_DIRS[s]
    const k = dq !== 0 ? o.q / dq : o.r / dr
    assert.ok(k > 0 && o.q === k * dq && o.r === k * dr, `slot ${s} along its direction`)
  }
})

test('neighbours keep the gap from home and from each other', () => {
  const big = (id, slot) => ({ id, slot, cells: [SHIP_CELL, ...Array.from({ length: 7 }, (_, i) => ({ q: i, r: 0 }))] })
  const ns = [big('a', 0), big('b', 1), big('c', 5)]
  const out = placeNeighbors(home, ns)
  const placed = ns.map((n) => shifted(n.cells, out.get(n.id)))
  for (const p of placed) assert.ok(minGap(home, p) > NEIGHBOR_GAP)
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) assert.ok(minGap(placed[i], placed[j]) > NEIGHBOR_GAP, `${i}/${j}`)
  }
})

test('a neighbour stays put while the gap holds', () => {
  const prev = new Map([['a', { q: 9, r: 0 }]])
  assert.deepEqual(placeNeighbors(home, [small('a', 0)], prev).get('a'), { q: 9, r: 0 })
})

test('a home that grows into the gap pushes the neighbour out along the same line', () => {
  const prev = new Map([['a', { q: 4, r: 0 }]])
  const grown = [...home, { q: 1, r: 0 }, { q: 2, r: 0 }]
  const o = placeNeighbors(grown, [small('a', 0)], prev).get('a')
  assert.equal(o.r, 0)
  assert.equal(o.q, 6)
})

test('an offset from another direction is not reused', () => {
  const prev = new Map([['a', { q: 0, r: -9 }]])
  assert.deepEqual(placeNeighbors(home, [small('a', 0)], prev).get('a'), { q: 4, r: 0 })
})

test('on a coast only the landward sides are used', () => {
  const dirs = landward({ x: -Math.SQRT1_2, z: -Math.SQRT1_2 })
  assert.deepEqual(dirs, [[1, 0], [1, -1], [0, 1]])
  // Slot 3 wraps onto the first landward side.
  assert.deepEqual(placeNeighbors(home, [small('a', 3)], new Map(), dirs).get('a'), { q: 4, r: 0 })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/neighbor-layout.test.mjs`
Expected: FAIL — `Cannot find module '…/src/world/neighbor-layout.js'`

- [ ] **Step 3: Write the module**

```js
// src/world/neighbor-layout.js
/**
 * Where a friend's settlement stands.
 *
 * Each neighbour owns one side of the home colony — slot 0 to 5, one per hex direction — and is
 * slid out along it until there are two clear rings between its cells and everyone else's. It is
 * sticky the same way the zone allocator is: a neighbour that still fits where it stood last time
 * stays exactly there, and only moves further out, never sideways and never back in.
 *
 * Pure and browser-free, like plot-move.js, for the same reason.
 */
import { HEX_DIRS, cellKey } from './plot-move.js'

export const MAX_NEIGHBORS = 6
/** Empty rings between a neighbour and anyone else. */
export const NEIGHBOR_GAP = 2
/** How far out a neighbour may be pushed before we stop looking. Far past any real colony. */
const MAX_STEPS = 400

/** Every cell within `gap` of any of these — ground a neighbour's cells may not touch. */
function keepOut(cells, gap, into = new Set()) {
  for (const c of cells) {
    for (let dq = -gap; dq <= gap; dq++) {
      for (let dr = Math.max(-gap, -dq - gap); dr <= Math.min(gap, -dq + gap); dr++) {
        into.add(cellKey(c.q + dq, c.r + dr))
      }
    }
  }
  return into
}

/** How many steps along `dir` an offset is, or 0 if it does not lie on that ray. */
function stepsAlong(offset, [dq, dr]) {
  const k = dq !== 0 ? offset.q / dq : offset.r / dr
  return Number.isInteger(k) && k > 0 && offset.q === k * dq && offset.r === k * dr ? k : 0
}

export function placeNeighbors(home, neighbors, previous = new Map(), directions = HEX_DIRS) {
  const blocked = keepOut(home, NEIGHBOR_GAP)
  const out = new Map()
  for (const n of [...neighbors].sort((a, b) => a.slot - b.slot)) {
    const dir = directions[((n.slot % directions.length) + directions.length) % directions.length]
    const prev = previous.get(n.id)
    let k = Math.max(1, prev ? stepsAlong(prev, dir) : 0)
    const fits = (step) => n.cells.every((c) => !blocked.has(cellKey(c.q + step * dir[0], c.r + step * dir[1])))
    while (k < MAX_STEPS && !fits(k)) k++
    const offset = { q: k * dir[0], r: k * dir[1] }
    out.set(n.id, offset)
    keepOut(n.cells.map((c) => ({ q: c.q + offset.q, r: c.r + offset.r })), NEIGHBOR_GAP, blocked)
  }
  return out
}

/** The hex directions whose world vector points away from the sea. Same maths as `hexToWorld`. */
export function landward(seaDir) {
  return HEX_DIRS.filter(([dq, dr]) => {
    const x = 1.5 * dq
    const z = Math.sqrt(3) * (dr + dq / 2)
    return x * seaDir.x + z * seaDir.z < 0
  })
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/neighbor-layout.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/world/neighbor-layout.js test/neighbor-layout.test.mjs
git commit -m "Place neighbours' settlements one per side, two clear rings out"
```

---

### Task 2: Friends on the page side

**Files:**
- Create: `src/game/neighbors.js`
- Modify: `src/game/api.js` (two fetchers)
- Test: `test/neighbor-links.test.mjs`

**Interfaces:**
- Consumes: Part 1's `NeighborResult` and `Snapshot` shapes.
- Produces (`src/game/neighbors.js`):
  - `NEIGHBOR_CAP = 6`
  - `newShareKey(bytes?) → string` (32 hex)
  - `shareLink({ lanAddress, port, key }) → string` (`''` if any part is missing)
  - `parseShareLink(text) → { url, key } | null`
  - `addNeighbor(list, text, { now }?) → { list, entry?, error }`
  - `removeNeighbor(list, id) → list`
  - `neighborThreadId(neighborId, sharedId) → 'nb:<neighborId>:<sharedId>'`
  - `hydrateNeighbors(saved, results) → Neighbor[]` where `Neighbor = { id, slot, name, online, status, lastSeenAt, projects: [{ name, cells: [[q,r]] }], threads: Thread[] }` and every thread carries `neighbor: { id, name }`, `canOpen: false`
  - `describeNeighbor(status, lastSeenAt, now?) → string`
- Produces (`src/game/api.js`): `fetchNeighbors() → Promise<{ neighbors: NeighborResult[] }>`, `fetchSharing() → Promise<{ listening, port, error, lanAddress, defaultName }>`

- [ ] **Step 1: Write the failing tests**

```js
// test/neighbor-links.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NEIGHBOR_CAP, addNeighbor, describeNeighbor, hydrateNeighbors, neighborThreadId,
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/neighbor-links.test.mjs`
Expected: FAIL — `Cannot find module '…/src/game/neighbors.js'`

- [ ] **Step 3: Write the module**

```js
// src/game/neighbors.js
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
```

- [ ] **Step 4: Add the two fetchers**

In `src/game/api.js`, add directly under `export const fetchThreads = () => req('/api/threads')`:

```js
/** Every saved friend, fetched by our own server — the page never talks to another machine. */
export const fetchNeighbors = () => req('/api/neighbors')

/** Whether the share port is open, and the address a friend would reach it on. */
export const fetchSharing = () => req('/api/sharing')
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/neighbor-links.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add src/game/neighbors.js src/game/api.js test/neighbor-links.test.mjs
git commit -m "Share links, the friends list, and friends' threads on the page side"
```

---

### Task 3: A wider grid, a wider camera, a ship that faces its own

**Files:**
- Modify: `src/agents/navigation.js:33-64` (constructor → `_allocate` + `resize`)
- Modify: `src/core/camera.js:68` (constructor field), `src/core/camera.js:260-267` (`_clampTarget`), add `setWorldLimit`
- Modify: `src/world/ship.js:31-35` (constructor `facing`)
- Test: `test/colony-motion.test.mjs` (append), `test/camera.test.mjs` (append)

**Interfaces:**
- Produces:
  - `new Navigation(half = 56)`, `nav.resize(half)` — re-allocates; caller must `rebuild` after.
  - `rig.setWorldLimit(r)` — target clamp radius becomes `max(82, r)`.
  - `new Ship(scene, position, facing?)` — `facing` is a `Vector3` the ramp points toward (default the world origin).

- [ ] **Step 1: Write the failing tests**

Append to `test/colony-motion.test.mjs`:

```js
test('the walkable square can grow to reach a neighbour', () => {
  const nav = new Navigation()
  assert.equal(nav.isBlocked(100, 0), true, 'outside the default grid')
  nav.resize(120)
  nav.rebuild([])
  assert.equal(nav.isBlocked(100, 0), false)
  nav.rebuild([{ x: 100, z: 0, r: 2, keep: 3 }])
  assert.equal(nav.isBlocked(100, 0), true)
  assert.ok(nav.findPath(90, 0, 110, 0), 'routes around it out there')
})
```

Append to `test/camera.test.mjs`:

```js
test('the camera may travel as far as the furthest neighbour, and no further', () => {
  const { rig } = fixture()
  rig.setFollow(null)
  rig.focus(new THREE.Vector3(150, 0, 0))
  assert.ok(Math.abs(rig.desiredTarget.x - 82) < 1e-9, 'clamped to the home colony by default')
  rig.setWorldLimit(200)
  rig.focus(new THREE.Vector3(150, 0, 0))
  assert.equal(rig.desiredTarget.x, 150)
  rig.setWorldLimit(10)
  rig.focus(new THREE.Vector3(150, 0, 0))
  assert.ok(Math.abs(rig.desiredTarget.x - 82) < 1e-9, 'never tighter than the home colony')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/colony-motion.test.mjs test/camera.test.mjs`
Expected: the two new tests FAIL — `nav.resize is not a function`, `rig.setWorldLimit is not a function`.

- [ ] **Step 3: Let the grid be sized**

In `src/agents/navigation.js`, replace the constructor (lines 34–64, from `constructor() {` through its closing `}`) with:

```js
  constructor(half = HALF) {
    this.cell = CELL
    this._allocate(half)

    this.generation = 0
    /** Bumped on every rebuild; agents use it to notice their path is stale. */
    this.version = 0
    /**
     * The obstacles that are walls to lean on, not just cells to route round: buildings,
     * with a `keep` radius the crew is pushed back out to. The grid alone cannot hold that
     * line — its cells are blocked at 80% of a footprint so the gaps between slots stay
     * walkable, and a half-cell of rounding on top of that lets an astronaut settle with
     * a shoulder through the wall.
     */
    this.solids = []
    /** The solids bucketed on a coarse grid, so a query only looks at its neighbourhood. */
    this._solidBuckets = new Map()
    this._bucket = 4
  }

  /** Everything indexed by grid cell, sized for a square `half` metres either side of the origin. */
  _allocate(half) {
    this.half = half
    this.size = Math.ceil((half * 2) / this.cell)
    const n = this.size * this.size

    this.blocked = new Uint8Array(n)
    this.gScore = new Float32Array(n)
    this.parent = new Int32Array(n)
    this.stamp = new Int32Array(n) // which search last touched this node
    this.closed = new Uint8Array(n)

    this.heap = new Int32Array(n)
    this.heapKey = new Float32Array(n)
    this.heapSize = 0
  }

  /**
   * Grow or shrink the walkable square. Neighbours' settlements sit well outside the home one,
   * and their crews walk this same grid. The bitmap starts empty, so a `rebuild` must follow;
   * bumping the version sends every agent for a fresh route.
   */
  resize(half) {
    if (half === this.half) return
    this._allocate(half)
    this.version++
  }
```

- [ ] **Step 4: Let the camera reach**

In `src/core/camera.js`, in the constructor, replace:

```js
    this.orbiting = false
    /** 0..1 share of ORBIT_RATE currently being applied — see `update`. */
```

with:

```js
    this.orbiting = false
    /** How far from the middle the target may go: the home colony, or the furthest neighbour. */
    this.worldLimit = WORLD_LIMIT
    /** 0..1 share of ORBIT_RATE currently being applied — see `update`. */
```

Replace `_clampTarget()` (lines 260–267) with:

```js
  _clampTarget() {
    const t = this.desiredTarget
    const len = Math.hypot(t.x, t.z)
    if (len > this.worldLimit) {
      t.x = (t.x / len) * this.worldLimit
      t.z = (t.z / len) * this.worldLimit
    }
  }

  /** Widen the leash to cover every settlement on the map. Never narrower than home. */
  setWorldLimit(r) {
    this.worldLimit = Math.max(WORLD_LIMIT, Number(r) || 0)
  }
```

- [ ] **Step 5: Let a ship face its own colony**

In `src/world/ship.js`, replace lines 31–35:

```js
  constructor(scene, position) {
    this.group = new THREE.Group()
    this.group.position.copy(position)
    // Turned so the ramp points back toward the middle of the colony.
    this.group.rotation.y = Math.atan2(-position.x, -position.z)
```

with:

```js
  constructor(scene, position, facing = null) {
    this.group = new THREE.Group()
    this.group.position.copy(position)
    // Turned so the ramp points back toward the middle of *its* colony: the world origin for
    // home, the middle of their own zones for a neighbour.
    const fx = facing ? facing.x - position.x : -position.x
    const fz = facing ? facing.z - position.z : -position.z
    this.group.rotation.y = Math.atan2(fx, fz)
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/colony-motion.test.mjs test/camera.test.mjs`
Expected: PASS (all, including the two new ones)

Run: `npm test` → only the 2 baseline failures. Run: `npx vite build` → succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/agents/navigation.js src/core/camera.js src/world/ship.js test/colony-motion.test.mjs test/camera.test.mjs
git commit -m "Let the nav grid and the camera reach past home, and a ship face its own colony"
```

---

### Task 4: Neighbours' bots use their own ramp and come last in the budget

**Files:**
- Create: `src/agents/roster-rank.js`
- Modify: `src/agents/astronauts.js:52-54` (rank), `:487-501` unchanged, `:555-578` (`_spawnAgent`), `:665-666` (`_updateAgent`), `:713-720` (`_nearDoor`), `:742-743` (`_sendHome`), `:808-810` (`_releaseQueued`), `:919` (caller)
- Test: `test/roster-rank.test.mjs`

**Interfaces:**
- Produces:
  - `rosterRank(entry) → number` — lower survives the cap first; any `entry.neighbor` adds 10.
  - Roster entries may carry `neighbor: { id, name }` and `doors: { shipDoor(): Vector3, shipAirlock(): Vector3 }`; agents keep both as `agent.neighbor` / `agent.doors`.

- [ ] **Step 1: Write the failing test**

```js
// test/roster-rank.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { rosterRank } from '../src/agents/roster-rank.js'

test('who wants you first, then who is busy', () => {
  const order = ['blocked', 'waiting', 'working', 'celebrating', 'idle', 'sleeping']
  const ranks = order.map((status) => rosterRank({ status }))
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks)
})

test("your own sleeping bot outranks a friend's stuck one", () => {
  assert.ok(rosterRank({ status: 'sleeping' }) < rosterRank({ status: 'blocked', neighbor: { id: 'nb_1' } }))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/roster-rank.test.mjs`
Expected: FAIL — `Cannot find module '…/src/agents/roster-rank.js'`

- [ ] **Step 3: Write the module**

```js
// src/agents/roster-rank.js
/**
 * Who survives a display cap: the ones that want you, then the ones doing something — and your
 * own crew before anybody's neighbours, whatever they are doing. A friend's busy afternoon must
 * never push your one waiting thread off the map.
 *
 * Its own module so the rule runs under node; astronauts.js cannot load there.
 */
const ROSTER_RANK = { blocked: 0, waiting: 1, working: 2, celebrating: 3, idle: 4, sleeping: 5 }
const NEIGHBOR_PENALTY = 10

export const rosterRank = (entry) => (entry.neighbor ? NEIGHBOR_PENALTY : 0) + (ROSTER_RANK[entry.status] ?? 6)
```

- [ ] **Step 4: Use it, and give each bot its own ship**

In `src/agents/astronauts.js`:

1. Delete lines 52–54 (the `/** Who survives a display cap… */` comment, `const ROSTER_RANK = …` and `const rosterRank = …`). Add to the imports at the top:

```js
import { rosterRank } from './roster-rank.js'
```

2. In `_spawnAgent(entry, walksOut = true)`, replace the first two lines of the body:

```js
    const door = this.world?.shipDoor?.() || new THREE.Vector3(0, 0, 0)
    const airlock = this.world?.shipAirlock?.() || door
```

with:

```js
    const door = this._door(entry) || new THREE.Vector3(0, 0, 0)
    const airlock = this._airlock(entry) || door
```

and in the `const agent = {` literal, directly after `thread: entry.thread,`, add:

```js
      // A neighbour's bot: never grabbed, never counted, and it comes and goes by its own ship.
      neighbor: entry.neighbor || null,
      doors: entry.doors || null,
```

3. In `_updateAgent(agent, entry)`, directly after `agent.thread = entry.thread`, add:

```js
    // A neighbour's ship is rebuilt if their settlement moves; the closures follow it.
    if (entry.doors) agent.doors = entry.doors
```

4. Replace `_nearDoor(pos) { … }` (lines 713–720) with:

```js
  /** Close enough to its own ramp that standing still there is in somebody's way. */
  _nearDoor(agent) {
    const door = this._door(agent)
    if (!door) return false
    const dx = agent.pos.x - door.x
    const dz = agent.pos.z - door.z
    return dx * dx + dz * dz < DOORWAY_CLEAR * DOORWAY_CLEAR
  }

  /** The ramp this one belongs to: its own ship's for a neighbour, the colony's otherwise. */
  _door(owner) {
    return owner?.doors?.shipDoor?.() || this.world?.shipDoor?.()
  }

  _airlock(owner) {
    return owner?.doors?.shipAirlock?.() || this.world?.shipAirlock?.()
  }
```

and change its one caller (around line 919) from `const inDoorway = this._nearDoor(agent.pos)` to:

```js
          const inDoorway = this._nearDoor(agent)
```

5. In `_sendHome(agent)`, replace `const door = this.world?.shipDoor?.()` with:

```js
    const door = this._door(agent)
```

6. In `_releaseQueued(dt)`, replace:

```js
    const airlock = this.world?.shipAirlock?.()
    const door = this.world?.shipDoor?.()
```

with:

```js
    const airlock = this._airlock(agent)
    const door = this._door(agent)
```

- [ ] **Step 5: Check nothing else reads the colony's door directly**

Run: `git grep -n "world?.shipDoor\|world?.shipAirlock" src/agents/astronauts.js`
Expected: exactly two lines, both inside `_door` / `_airlock`.

- [ ] **Step 6: Run the tests and the build**

Run: `node --test test/roster-rank.test.mjs` → PASS (2 tests). `npm test` → only the 2 baseline failures. `npx vite build` → succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/agents/roster-rank.js src/agents/astronauts.js test/roster-rank.test.mjs
git commit -m "Neighbours' bots use their own ramp and come last in the display budget"
```

---

### Task 5: Flat ground under every settlement

**Files:**
- Modify: `src/world/planet.js` — `COAST_DIR` export (line 541), new site state and helpers after line 557, `createTerrain` (565–567, 611), `sampleHeight` (703–704, 760), `shorelinePoints` (1139)
- Test: `test/terrain-sites.test.mjs`

**Interfaces:**
- Produces: `setSettlementSites(sites: {x,z,r}[])`, `groundSize() → number`, `COAST_DIR` (exported), from `src/world/planet.js`. With no sites set, every height and the ground size are exactly what they were.

- [ ] **Step 1: Write the failing tests**

```js
// test/terrain-sites.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { GROUND_SIZE, PLANETS, groundSize, setSettlementSites, terrainHeight } from '../src/world/planet.js'

const moon = PLANETS.moon
/** How far the ground rises and falls over a 40 m square — what a plot would have to sit on. */
const spread = (cx, cz = 0) => {
  let lo = Infinity
  let hi = -Infinity
  for (let dx = -20; dx <= 20; dx += 4) {
    for (let dz = -20; dz <= 20; dz += 4) {
      const y = terrainHeight(cx + dx, cz + dz, moon)
      lo = Math.min(lo, y)
      hi = Math.max(hi, y)
    }
  }
  return hi - lo
}

test("a neighbour's site is flat ground, like the home colony", () => {
  setSettlementSites([])
  const before = spread(140)
  // Measured on the Moon: ~0.45 across the home colony, ~10.4 across this patch of hills.
  assert.ok(before > 3, `the far field is hilly to begin with (${before})`)
  setSettlementSites([{ x: 140, z: 0, r: 40 }])
  const after = spread(140)
  assert.ok(after < 1.2, `flat enough to build on: ${after}`)
  assert.ok(after < before / 4, `far flatter than the hills it replaced: ${after} vs ${before}`)
  setSettlementSites([])
  assert.equal(spread(140), before, 'and the hills come back when the neighbour leaves')
})

test('with no neighbours nothing about the ground changes', () => {
  setSettlementSites([])
  assert.equal(groundSize(), GROUND_SIZE)
})

test('the ground grows to hold the furthest neighbour', () => {
  setSettlementSites([{ x: 200, z: 0, r: 30 }])
  assert.equal(groundSize(), 580)
  setSettlementSites([])
})
```

(`580` = `ceil(2 × (200 + 30 + 60) / 20) × 20`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/terrain-sites.test.mjs`
Expected: FAIL — `setSettlementSites is not a function` (import is `undefined`).

- [ ] **Step 3: Add the sites**

In `src/world/planet.js`:

1. Change line 541 from `const COAST_DIR = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 }` to:

```js
export const COAST_DIR = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 }
```

2. Directly after `export const SKY_MAX_CELLS = 96` (line 557), add:

```js
/**
 * Neighbours' settlements, as flat discs `{ x, z, r }` in world units. Home is always flat inside
 * `COLONY_RADIUS` of the origin; each of these is flat inside `r` of its own centre, with the same
 * ramp out to the hills. Empty unless a friend is on the map, and then everything below behaves
 * exactly as it did before.
 */
let _sites = []

export function setSettlementSites(sites) {
  _sites = (sites || []).map(({ x, z, r }) => ({ x, z, r }))
  _shores.clear()
}

/** The ground plane's width: the default, or wide enough to hold the furthest neighbour. */
export function groundSize() {
  let reach = 0
  for (const s of _sites) reach = Math.max(reach, Math.hypot(s.x, s.z) + s.r + 60)
  return Math.max(GROUND_SIZE, Math.ceil((reach * 2) / 20) * 20)
}

/** 0 on any colony's flat ground, 1 well out in the hills. */
function farField(x, z) {
  let out = THREE.MathUtils.smoothstep(Math.hypot(x, z), COLONY_RADIUS - 6, COLONY_RADIUS + 40)
  for (const s of _sites) out = Math.min(out, THREE.MathUtils.smoothstep(Math.hypot(x - s.x, z - s.z), s.r - 6, s.r + 40))
  return out
}

/** Distance to the nearest colony's middle, for the far-field darkening. */
function colonyDistance(x, z) {
  let d = Math.hypot(x, z)
  for (const s of _sites) d = Math.min(d, Math.hypot(x - s.x, z - s.z))
  return d
}

/** A crater that would land on a neighbour's ground is simply not there. */
function craterOnSite(crater) {
  return _sites.some((s) => Math.hypot(crater.x - s.x, crater.z - s.z) < s.r + crater.r * 1.5 + 6)
}
```

3. In `createTerrain`, replace lines 566–567:

```js
  const segments = DETAIL_SEGMENTS[detail] || DETAIL_SEGMENTS.medium
  const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, segments, segments)
```

with:

```js
  // A wider plane for a neighbour far out keeps the same vertex spacing, up to twice the count.
  const size = groundSize()
  const segments = Math.round((DETAIL_SEGMENTS[detail] || DETAIL_SEGMENTS.medium) * Math.min(2, size / GROUND_SIZE))
  const geo = new THREE.PlaneGeometry(size, size, segments, segments)
```

and replace line 611:

```js
    c.multiplyScalar(1 - THREE.MathUtils.smoothstep(dist, COLONY_RADIUS * 0.8, GROUND_SIZE * 0.36) * 0.55)
```

with:

```js
    c.multiplyScalar(1 - THREE.MathUtils.smoothstep(colonyDistance(x, z), COLONY_RADIUS * 0.8, GROUND_SIZE * 0.36) * 0.55)
```

4. In `sampleHeight`, replace line 704:

```js
  const outside = THREE.MathUtils.smoothstep(dist, COLONY_RADIUS - 6, COLONY_RADIUS + 40)
```

with:

```js
  const outside = farField(x, z)
```

and make the first line inside `for (const crater of craters) {` (line 760):

```js
    if (_sites.length && craterOnSite(crater)) continue
```

5. In `shorelinePoints`, replace `const half = GROUND_SIZE / 2 - spacing` with:

```js
  const half = groundSize() / 2 - spacing
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/terrain-sites.test.mjs` → PASS (3 tests). `npm test` → only the 2 baseline failures. `npx vite build` → succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/world/planet.js test/terrain-sites.test.mjs
git commit -m "Flatten the ground under neighbours' settlements and grow the plane to reach them"
```

---

### Task 6: Neighbours in the colony

The biggest change. Nothing in `colony.js` can run under node (it pulls in the astronaut renderer), so this task is verified by the existing suites staying green, the build, and a console-injected neighbour in the running page.

**Files:**
- Modify: `src/game/colony.js` (imports; constructor; `_buildTerrain`; `_footprintCells`; `_buildScatter`; `_buildGrass`; `_buildWater`; `setThreads`; `_syncPlots`; `_rebuildNavigation`; `plotAt`; `pickLabel`; `_updateLabels`; `update`; `_isLive`; `_isActive`; `_scaffoldSites`; `_updatePlots`; `dispose`; new methods)

**Interfaces:**
- Consumes: `placeNeighbors`, `landward` (Task 1); `Neighbor` shape from `hydrateNeighbors` (Task 2); `Ship(scene, pos, facing)`, `nav.resize` (Task 3); entry `neighbor` / `doors` (Task 4); `setSettlementSites`, `groundSize`, `COAST_DIR` (Task 5).
- Produces (used by Task 7):
  - `colony.setThreads(threads, archivedIds, hiddenProjects, knownIds, neighbors = [])`
  - `colony.neighborPlots: Map<plotId, Plot>` — each `plot.neighbor = { id, name }`
  - `colony.neighborThreads: Map<threadId, Thread>`
  - `colony.neighborSites: { id, x, z, r }[]`
  - `colony.worldReach() → number`
  - `colony.plotAt` / `colony.pickLabel` may now return a neighbour plot (check `plot.neighbor`).

- [ ] **Step 1: Imports and constants**

In `src/game/colony.js`:

Replace line 3:

```js
import { PLANETS, createTerrain, createScatter, terrainHeight } from '../world/planet.js'
```

with:

```js
import { COAST_DIR, PLANETS, createTerrain, createScatter, groundSize, setSettlementSites, terrainHeight } from '../world/planet.js'
```

In the `from '../world/plots.js'` import block (lines 13–23), add `hexToWorld,` after `hashString,`.

Replace line 24 (`import { translateCells } from '../world/plot-move.js'`) with:

```js
import { SHIP_CELL, translateCells } from '../world/plot-move.js'
import { landward, placeNeighbors } from '../world/neighbor-layout.js'
```

Add under `const LAYOUT_MEMORY = 80`:

```js
/** The dot on a neighbour's ship sign. A cool blue that is not any repo's accent. */
const NEIGHBOR_SIGN = 0x8fb4ee
```

- [ ] **Step 2: Constructor state**

Directly after `this.usedAccents = new Set()` in the constructor, add:

```js
    /**
     * Friends' settlements. Drawn on the same lattice as the home colony, but kept off its
     * books: nothing here is saved, dragged, hidden, archived, or counted in the stats.
     */
    this.neighborPlots = new Map()
    this.neighborShips = new Map()
    this.neighborThreads = new Map()
    this.neighborOffsets = new Map()
    this.neighborSites = []
    this._neighborKnown = new Set()
    this._sitesSignature = '[]'
    /** Every plot on the ground, home first — what anything about the *terrain* iterates. */
    this.worldPlots = []
```

- [ ] **Step 3: Terrain-side methods iterate every plot and every ship**

1. In `_buildTerrain`, directly after `this.ship.group.position.y = terrainHeight(ship.x, ship.z, this.planet)`, add:

```js
    for (const n of this.neighborShips.values()) {
      const p = n.ship.group.position
      p.y = terrainHeight(p.x, p.z, this.planet)
    }
```

2. Replace the whole `_footprintCells()` method with:

```js
  /** Every hex cell on the ground — home zones, home ship, then each neighbour's — in world space. */
  _footprintCells() {
    const list = []
    const add = (plot) => {
      for (const local of plot.localCenters) list.push({ x: plot.center.x + local.x, z: plot.center.z + local.z })
    }
    for (const plot of this.plotOrder) add(plot)
    // Home's ship before any neighbour's cells: the sky island's cut-out has a cap, and if it is
    // ever reached it is a friend's corner that goes missing, not your own lander's ground.
    const ship = shipPosition()
    list.push({ x: ship.x, z: ship.z })
    for (const plot of this.neighborPlots.values()) add(plot)
    for (const n of this.neighborShips.values()) list.push({ x: n.ship.group.position.x, z: n.ship.group.position.z })
    return list.slice(0, SKY_MAX_CELLS)
  }

  /** Where every lander stands: home's, then each neighbour's. */
  _shipSpots() {
    return [shipPosition(), ...[...this.neighborShips.values()].map((n) => n.ship.group.position)]
  }
```

3. In `_buildWater`, change the `createWater({` call to pass the plane size:

```js
    this.water = createWater({
      planet: this.planet,
      heightAt: (x, z) => terrainHeight(x, z, this.planet),
      size: groundSize(),
      quality: detail === 'high' ? 'high' : detail === 'low' ? 'low' : 'medium',
    })
```

4. In `_buildScatter`, replace everything from `const clear = []` through `if (this.nav) this._rebuildNavigation()` with:

```js
    const clear = []
    for (const plot of this.worldPlots) {
      for (const local of plot.localCenters) {
        clear.push({ x: plot.center.x + local.x, z: plot.center.z + local.z, r: 8.6 })
      }
    }
    const aprons = this._shipSpots().map((p) => ({ x: p.x, z: p.z, r: 7.5 }))
    clear.push(...aprons)
    this.scatterGroup = createScatter(this.planet, this.settings.get('scatterDensity'), clear, 4242, (x, z) => this.onIsland(x, z))
    this.worldGroup.add(this.scatterGroup)
    this._scatterFootprint = this._plotFootprint()
    this._buildGrass(aprons)
    // The crew routes around scatter, so a new scatter is a new navigation grid.
    if (this.nav) this._rebuildNavigation()
```

5. Replace the `_buildGrass(clear)` method's signature and its `const apron = …` line and `blocked:` callback. The method becomes:

```js
  _buildGrass(aprons) {
    if (this.grass) {
      this.grass.dispose()
      this.grass = null
    }
    const detail = this.settings.get('groundDetail')
    this.grass = createGrass({
      planet: this.planet,
      heightAt: (x, z) => terrainHeight(x, z, this.planet),
      blocked: (x, z) => !this.onIsland(x, z) ||
        this.worldPlots.some((plot) => plot.containsWorld(x, z, -0.4)) ||
        aprons.some((a) => (x - a.x) ** 2 + (z - a.z) ** 2 < a.r * a.r),
      density: this.settings.get('scatterDensity'),
      quality: detail === 'high' ? 'high' : detail === 'low' ? 'low' : 'medium',
    })
    if (this.grass) this.worldGroup.add(this.grass.mesh)
  }
```

6. In `_plotFootprint()`, change `this.plotOrder` to `this.worldPlots`.

- [ ] **Step 4: Split the footprint tail out of `_syncPlots`**

In `_syncPlots`, replace everything from `this.plotOrder = [...this.plots.values()]` to the end of the method (the scatter check, the `deckedCells` block and `this._syncLabels()`) with just:

```js
    this.plotOrder = [...this.plots.values()]
  }
```

and add this new method directly after `_syncPlots`:

```js
  /**
   * After home and neighbour zones have both been reconciled: the ground under all of them.
   *
   * A neighbour arriving, leaving or moving changes the flat discs the terrain is built around,
   * and that is a terrain rebuild. Anything else that moved is only scatter, as before — and on an
   * island in the sea, the coast itself moves, which is the whole terrain.
   */
  _syncFootprint() {
    this.worldPlots = [...this.plotOrder, ...this.neighborPlots.values()]
    const sites = JSON.stringify(this.neighborSites)
    const sitesMoved = sites !== this._sitesSignature
    if (sitesMoved) {
      this._sitesSignature = sites
      setSettlementSites(this.neighborSites)
    }
    if (this.scatterGroup && (sitesMoved || this._plotFootprint() !== this._scatterFootprint)) {
      if (sitesMoved || this.planet.shape === 'island') this._buildTerrain()
      else {
        this._buildScatter()
        if (this.island) this._syncIslandRock()
      }
    }
    // Which hex cells are decked. Ground height is asked for once per moving agent per
    // frame, so it wants to be a lookup rather than a scan over every plot's every tile.
    this.deckedCells = new Set()
    for (const plot of this.worldPlots) {
      for (const cell of plot.cells) this.deckedCells.add(`${cell.q},${cell.r}`)
    }
    this._syncLabels()
  }
```

- [ ] **Step 5: Sticky slots as a method both rosters use**

Add this method directly after `_syncFootprint`:

```js
  /**
   * Oldest thread first, so the *first* assignment of slots is deterministic; after that a thread
   * keeps the slot it was given for as long as the plot stands. Numbering by position in the list,
   * which is what this used to do, meant one archive shifted every younger sibling one slot along
   * — every building on the plot moved and every astronaut walked, for a thread that had left.
   */
  _assignSlots(plot, list) {
    list.sort((a, b) => a.createdAt - b.createdAt)
    const slotOf = plot.slotOf || (plot.slotOf = new Map())
    for (const id of [...slotOf.keys()]) if (!list.some((t) => t.id === id)) slotOf.delete(id)
    const taken = new Set(slotOf.values())
    for (const thread of list) {
      if (slotOf.has(thread.id)) continue
      let slot = 0
      while (taken.has(slot)) slot++
      taken.add(slot)
      slotOf.set(thread.id, slot)
    }
    return slotOf
  }
```

In `setThreads`, inside `for (const [name, list] of projects) {`, replace everything from the comment `// Oldest thread first, so the *first* assignment …` through the end of the `for (const thread of list) { … slotOf.set(thread.id, slot) }` loop with:

```js
      const slotOf = this._assignSlots(plot, list)
```

(The `list.forEach((thread) => { const i = slotOf.get(thread.id) …` that follows is unchanged.)

- [ ] **Step 6: The neighbour pass**

Add these methods directly after `_assignSlots`:

```js
  /**
   * A neighbour's zones in their own frame: their saved layout where they sent one, and anything
   * they have not placed yet placed here by the same allocator, around what they have.
   */
  _neighborLayout(n) {
    const counts = new Map()
    for (const t of n.threads) counts.set(t.project, (counts.get(t.project) || 0) + 1)
    const given = new Map()
    for (const p of n.projects) {
      if (p.cells.length) given.set(p.name, p.cells.map(([q, r]) => ({ q, r })))
    }
    const sized = [...counts]
      .map(([id, size]) => ({ id, size }))
      .sort((a, b) => b.size - a.size || a.id.localeCompare(b.id))
    return allocateCells(sized, given)
  }

  /**
   * Friends' settlements, rebuilt from what their machines last said.
   *
   * Each arrives in its own frame and is shifted out along its slot's direction until there are
   * two clear rings between it and everyone else. A zone is torn down and raised again only when
   * its footprint moved, exactly like a home zone; a ship only when its settlement moved.
   */
  _syncNeighbors(neighbors) {
    const framed = neighbors.map((n) => ({ ...n, layout: this._neighborLayout(n) }))
    const home = [SHIP_CELL, ...this.plotOrder.flatMap((plot) => plot.cells)]
    this.neighborOffsets = placeNeighbors(
      home,
      framed.map((n) => ({ id: n.id, slot: n.slot, cells: [SHIP_CELL, ...[...n.layout.values()].flat()] })),
      this.neighborOffsets,
      this.planet.shape === 'coast' ? landward(COAST_DIR) : undefined
    )

    const wanted = new Map()
    for (const n of framed) {
      const off = this.neighborOffsets.get(n.id)
      for (const [name, cells] of n.layout) {
        if (!cells.length) continue
        const moved = cells.map((c) => ({ q: c.q + off.q, r: c.r + off.r }))
        const id = `nb:${n.id}/${name}`
        wanted.set(id, { n, name, cells: moved, signature: `${id}:${moved.map((c) => `${c.q},${c.r}`).join('/')}` })
      }
    }

    for (const [id, plot] of this.neighborPlots) {
      if (wanted.get(id)?.signature === plot.signature) continue
      this.plotGroup.remove(plot.group)
      if (plot.label) {
        this.labelGroup.remove(plot.label)
        plot.label.userData.dispose?.()
      }
      plot.dispose()
      this.neighborPlots.delete(id)
    }
    for (const [id, want] of wanted) {
      if (this.neighborPlots.has(id)) continue
      // Hashed rather than probed: the friend's own screen sorts out collisions between their
      // zones, and a colour that depended on which of their repos arrived first would flicker.
      const accent = PLOT_PALETTE[hashString(want.name) % PLOT_PALETTE.length]
      const plot = new Plot({ id, name: want.name, index: 0, cells: want.cells, accent })
      plot.signature = want.signature
      plot.neighbor = { id: want.n.id, name: want.n.name }
      this.neighborPlots.set(id, plot)
      this.plotGroup.add(plot.group)
      const label = createLabel(want.name, accent)
      label.position.set(plot.labelAnchor.x, 3.2, plot.labelAnchor.z)
      plot.label = label
      this.labelGroup.add(label)
    }

    const present = new Set(framed.map((n) => n.id))
    for (const [id, entry] of [...this.neighborShips]) {
      const off = this.neighborOffsets.get(id)
      if (!present.has(id) || entry.q !== off.q || entry.r !== off.r) this._removeNeighborShip(id)
    }
    for (const n of framed) {
      const off = this.neighborOffsets.get(n.id)
      let entry = this.neighborShips.get(n.id)
      if (!entry) {
        const spot = hexToWorld(SHIP_CELL.q + off.q, SHIP_CELL.r + off.r)
        const middle = hexToWorld(off.q, off.r)
        const ship = new Ship(
          this.scene,
          new THREE.Vector3(spot.x, terrainHeight(spot.x, spot.z, this.planet), spot.z),
          new THREE.Vector3(middle.x, 0, middle.z)
        )
        entry = { ship, label: null, text: '', q: off.q, r: off.r }
        this.neighborShips.set(n.id, entry)
      }
      // The minutes live in Settings; the sign only says whether they are here.
      const text = n.online ? n.name : `${n.name} · away`
      if (entry.text !== text) {
        if (entry.label) {
          this.labelGroup.remove(entry.label)
          entry.label.userData.dispose?.()
        }
        const p = entry.ship.group.position
        entry.label = createLabel(text, NEIGHBOR_SIGN)
        entry.label.position.set(p.x, 8.5, p.z)
        this.labelGroup.add(entry.label)
        entry.text = text
      }
    }

    this.neighborSites = framed.map((n) => this._siteOf(n.id))
  }

  _removeNeighborShip(id) {
    const entry = this.neighborShips.get(id)
    if (!entry) return
    entry.ship.dispose()
    if (entry.label) {
      this.labelGroup.remove(entry.label)
      entry.label.userData.dispose?.()
    }
    this.neighborShips.delete(id)
  }

  /** A neighbour's flat ground: the middle of everything they hold, and far enough to cover it. */
  _siteOf(id) {
    const pts = []
    for (const plot of this.neighborPlots.values()) {
      if (plot.neighbor.id !== id) continue
      for (const l of plot.localCenters) pts.push({ x: plot.center.x + l.x, z: plot.center.z + l.z })
    }
    const ship = this.neighborShips.get(id)?.ship.group.position
    if (ship) pts.push({ x: ship.x, z: ship.z })
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const z = pts.reduce((s, p) => s + p.z, 0) / pts.length
    const r = Math.max(...pts.map((p) => Math.hypot(p.x - x, p.z - z))) + PLOT_CELL
    return { id, x: Math.round(x), z: Math.round(z), r: Math.ceil(r) }
  }

  /** A home plot or a neighbour's, by plot id. */
  _plotById(id) {
    return this.plots.get(id) || this.neighborPlots.get(id)
  }

  /** How far from the middle the furthest zone or ship reaches — what the camera and grid cover. */
  worldReach() {
    let r = 0
    for (const plot of this.worldPlots) {
      for (const l of plot.localCenters) r = Math.max(r, Math.hypot(plot.center.x + l.x, plot.center.z + l.z))
    }
    for (const p of this._shipSpots()) r = Math.max(r, Math.hypot(p.x, p.z))
    return r + PLOT_CELL * 2
  }
```

- [ ] **Step 7: Wire the neighbour pass into `setThreads`**

1. Change the signature line to:

```js
  setThreads(threads, archivedIds = new Set(), hiddenProjects = new Set(), knownIds = new Set(), neighbors = []) {
```

2. Replace the single line `this._syncPlots(projects)` with:

```js
    this._syncPlots(projects)
    this._syncNeighbors(neighbors)
    this._syncFootprint()
```

3. Directly after the home `for (const [name, list] of projects) { … }` loop closes, and before the comment `// Anything that dropped out of the scan`, add:

```js
    // Friends' bots: the same buildings, sites and behaviours, but never counted, never urgent,
    // and each one walking out of — and back into — its own owner's ship.
    this.neighborThreads = new Map()
    for (const n of neighbors) {
      const ship = this.neighborShips.get(n.id)?.ship
      const doors = ship ? { shipDoor: () => ship.shipDoor(), shipAirlock: () => ship.shipAirlock() } : null
      const byPlot = new Map()
      for (const thread of n.threads) {
        const plot = this.neighborPlots.get(`nb:${n.id}/${thread.project}`)
        if (!plot) continue
        if (!byPlot.has(plot)) byPlot.set(plot, [])
        byPlot.get(plot).push(thread)
      }
      for (const [plot, list] of byPlot) {
        const slotOf = this._assignSlots(plot, list)
        for (const thread of list) {
          const status = statusFor(thread, now)
          if (status === 'waiting' || status === 'blocked' || status === 'working') active.add(plot.id)
          const building = this._syncBuilding(thread, plot, slotOf.get(thread.id))
          seenBuildings.add(thread.id)
          this.neighborThreads.set(thread.id, thread)
          roster.push({
            id: thread.id,
            thread,
            status,
            site: null,
            anchor: building.mesh.position.clone(),
            known: this._neighborKnown.has(thread.id),
            neighbor: thread.neighbor,
            doors,
          })
          this._neighborKnown.add(thread.id)
        }
      }
    }
```

4. In the site loop near the end of `setThreads`, replace:

```js
      member.site = this._workSite(this.plots.get(entry.plot), entry, entry.slot)
```

with:

```js
      member.site = this._workSite(this._plotById(entry.plot), entry, entry.slot)
```

- [ ] **Step 8: The rest of the colony looks at every plot, and at every thread it draws**

1. `_rebuildNavigation`: change `for (const plot of this.plotOrder) {` (the clutter loop) to `for (const plot of this.worldPlots) {`, and replace the last three lines:

```js
    const ship = shipPosition()
    obstacles.push({ x: ship.x, z: ship.z, r: 3.4 + AGENT_RADIUS })
    this.nav.rebuild(obstacles)
```

with:

```js
    for (const ship of this._shipSpots()) obstacles.push({ x: ship.x, z: ship.z, r: 3.4 + AGENT_RADIUS })
    // Wide enough for every settlement on the map: a neighbour's crew walks this grid too.
    const half = Math.max(56, Math.ceil((this.worldReach() + 12) / 8) * 8)
    if (half !== this.nav.half) this.nav.resize(half)
    this.nav.rebuild(obstacles)
```

2. `plotAt` and `pickLabel`: change `for (const plot of this.plotOrder) {` to `for (const plot of this.worldPlots) {` in both.

3. `_updateLabels(dt)`: change `for (const plot of this.plotOrder) {` to `for (const plot of this.worldPlots) {`, and add after that loop, before the method's closing brace:

```js
    for (const n of this.neighborShips.values()) {
      if (!n.label) continue
      const next = THREE.MathUtils.damp(n.label.material.opacity, show ? 1 : 0, 9, dt)
      n.label.material.opacity = next
      n.label.visible = next > 0.01
    }
```

4. `_updatePlots`: change `for (const plot of this.plotOrder)` to `for (const plot of this.worldPlots)`.

5. `update(dt, elapsed, focus)`: directly after `this.ship.update(dt, elapsed, night)`, add:

```js
    for (const n of this.neighborShips.values()) n.ship.update(dt, elapsed, night)
```

6. `_isLive(id)` and `_isActive(id)`: in both, change `const thread = this.threads.get(id)` to:

```js
    const thread = this.threads.get(id) || this.neighborThreads.get(id)
```

7. `_scaffoldSites`: change `contains: (x, z) => this.plots.get(entry.plot)?.containsWorld(x, z, 0.2),` to:

```js
        contains: (x, z) => this._plotById(entry.plot)?.containsWorld(x, z, 0.2),
```

8. `dispose()`: add as its first line:

```js
    for (const id of [...this.neighborShips.keys()]) this._removeNeighborShip(id)
```

- [ ] **Step 9: Check no ground-side loop still reads home only**

Run: `git grep -n "plotOrder" src/game/colony.js`
Expected, and nothing else: the constructor's `this.plotOrder = []`, `_footprintCells` (home first, on purpose), `_syncPlots`'s `this.plotOrder = [...]`, `_syncFootprint`'s `[...this.plotOrder, …]`, and `_syncNeighbors`'s `const home = [SHIP_CELL, ...this.plotOrder…]`.

- [ ] **Step 10: Run the suites and the build**

Run: `npm test` → only the 2 baseline failures. Run: `npx vite build` → succeeds.

- [ ] **Step 11: See a neighbour by hand**

Run `npm run dev` (or use the server already on 5274) and open `http://localhost:5274`. In the browser devtools console, paste:

```js
const bc = window.botCrossing
const mk = (i, project, extra = {}) => ({
  id: `nb:test:n:${String(i).padStart(16, '0')}`, title: project, preview: '', project,
  harness: 'claude-code', harnessName: 'Claude Code', running: i % 2 === 0, unread: i === 3,
  hasError: false, prState: '', lastActivityAt: Date.now(), createdAt: i, sizeBytes: 2 ** 14,
  archived: false, canOpen: false, ref: null, neighbor: { id: 'test', name: 'Test friend' },
})
const friend = {
  id: 'test', slot: 0, name: 'Test friend', online: true, status: 'online', lastSeenAt: Date.now(),
  projects: [{ name: 'alpha', cells: [] }, { name: 'beta', cells: [] }],
  threads: [mk(1, 'alpha'), mk(2, 'alpha'), mk(3, 'beta'), mk(4, 'beta'), mk(5, 'beta')],
}
bc.colony.setThreads(bc.threads, new Set(), new Set(), new Set(), [friend])
bc.rig.setWorldLimit(bc.colony.worldReach())
const site = bc.colony.neighborSites[0]
bc.rig.focus({ x: site.x, y: 0, z: site.z }, { distance: 60 })
```

(`rig.focus` only reads `x`/`y`/`z` off the point, so a plain object does; `THREE` is not a global in the page.)

Expected: a second, smaller settlement two rings off one side of yours, on flat ground, with its own ship signed *Test friend*; five bots walk out of *that* ship to two zones named alpha and beta; one waves (`?`), two hammer. Your own colony has not moved. The next poll (≤15 s) removes the test friend again, because `main.js` does not pass neighbours yet — that is expected until Task 7.

- [ ] **Step 12: Commit**

```bash
git add src/game/colony.js
git commit -m "Draw neighbours' zones, ships and bots on the shared lattice"
```

---

### Task 7: The page drives it, and a neighbour's bot is look-don't-touch

**Files:**
- Modify: `src/main.js` (imports; state defaults; globals; `actions.focusStatus`; `actions.progressFor`; `select`; `pointerdown`; canvas `pointerup`; `applyThreads`; `poll`; `boot`)
- Modify: `src/ui/hud.js:686-727` (`setSelection`)
- Modify: `src/ui/styles.css` (append)

**Interfaces:**
- Consumes: `fetchNeighbors` and `hydrateNeighbors` (Task 2), `colony.setThreads(…, neighbors)` / `worldReach` / `neighborThreads` / `plot.neighbor` / `agent.neighbor` (Tasks 4, 6), `rig.setWorldLimit` (Task 3).
- Produces: `neighborResults` (module global in main.js, the last `NeighborResult[]`), used by Task 8.

- [ ] **Step 1: Imports, state and globals**

In `src/main.js`, add `fetchNeighbors,` to the `./game/api.js` import list (after `fetchThreads,`), and add:

```js
import { hydrateNeighbors } from './game/neighbors.js'
```

Change line 65 to include the two new fields:

```js
let state = { archived: [], archivedAt: {}, opened: [], plots: {}, seen: {}, hiddenProjects: [], viewedAt: {}, sharing: { enabled: false, key: '', name: '' }, neighbors: [] }
```

Directly after `const hoverGround = new THREE.Vector3()` add:

```js
/** What our server last fetched from each friend — `GET /api/neighbors`. */
let neighborResults = []
```

- [ ] **Step 2: Keep neighbours out of your own shortcuts**

In `actions.focusStatus`, change the pool line to:

```js
    const pool = colony.astronauts.agents.filter((a) => !a.neighbor && (key ? a.status === key : true))
```

In `actions.progressFor`, change the lookup to:

```js
    const thread = threads.find((t) => t.id === id) || colony.neighborThreads.get(id)
```

In `select(id, …)`, change the sidebar-follow line to:

```js
  if (!thread?.neighbor && thread?.project && colony.plots.has(thread.project)) selectedProject = thread.project
```

- [ ] **Step 3: No grabbing a friend's things, and a hint for their zones**

In the canvas `pointerdown` listener, change `if (!canGrab(agent)) return` to:

```js
    if (!canGrab(agent) || agent.neighbor) return
```

and `if (!plot) return` (the zone branch) to:

```js
    if (!plot || plot.neighbor) return
```

In the canvas `pointerup` listener (the click one), replace its last three lines:

```js
  const plot = plotUnder(e, p)
  if (plot) selectProject(plot.name, {})
  else actions.closeProject()
```

with:

```js
  const plot = plotUnder(e, p)
  if (plot?.neighbor) {
    // A friend's zone has no folder here and nothing to do to it — say whose it is and stop.
    let bots = 0
    for (const t of colony.neighborThreads.values()) if (t.neighbor.id === plot.neighbor.id && t.project === plot.name) bots++
    hud.hint(`${plot.neighbor.name} · ${plot.name} · ${bots} bot${bots === 1 ? '' : 's'}`)
  } else if (plot) selectProject(plot.name, {})
  else actions.closeProject()
```

- [ ] **Step 4: Pass neighbours to the colony, and fetch them on the poll**

In `applyThreads`, replace:

```js
  const stats = colony.setThreads(list, archivedSet, hiddenSet, known)
```

with:

```js
  const stats = colony.setThreads(list, archivedSet, hiddenSet, known, hydrateNeighbors(state.neighbors, neighborResults))
  rig.setWorldLimit(colony.worldReach())
```

Replace the body of `poll()`'s `try { … }` block with:

```js
    // Friends ride the same clock as your own threads. A failed neighbour fetch keeps what we
    // had: their settlement going quiet is the server's call, made per friend.
    const wantNeighbors = (state.neighbors || []).length > 0
    const [res, nb] = await Promise.all([
      fetchThreads(),
      wantNeighbors ? fetchNeighbors().catch(() => null) : Promise.resolve({ neighbors: [] }),
    ])
    if (nb) neighborResults = nb.neighbors || []
    applyThreads(res.threads || [])
    hud.removeBoot()
```

- [ ] **Step 5: The read-only card**

In `src/ui/hud.js` `setSelection(agent, thread)`, replace:

```js
    this.$('.thread-pop .title').textContent = thread.title || 'Untitled thread'
    const status = STATUS_LABEL[agent.status] || agent.status
```

with:

```js
    // A friend's bot says whose it is and what it is up to, and offers nothing to press.
    const neighbor = thread.neighbor || null
    card.classList.toggle('readonly', Boolean(neighbor))
    this.$('.thread-pop .title').textContent = neighbor
      ? `${neighbor.name} · ${thread.project}`
      : thread.title || 'Untitled thread'
    const status =
      neighbor && agent.status === 'waiting' ? `Waiting on ${neighbor.name}` : STATUS_LABEL[agent.status] || agent.status
```

Append to `src/ui/styles.css`:

```css
/* A neighbour's bot: who and what, and nothing to press. */
.thread-pop.readonly .pair,
.thread-pop.readonly .progress {
  display: none;
}
```

- [ ] **Step 6: Run the suites and the build**

Run: `npm test` → only the 2 baseline failures. Run: `npx vite build` → succeeds.

- [ ] **Step 7: Check by hand with a real friend**

This needs a second server sharing. In a second PowerShell window (throwaway data dir, so your real colony is untouched):

```powershell
$env:BOT_CROSSING_DATA = "$env:TEMP\bc-friend"; $env:PORT = '5280'; $env:BOT_CROSSING_SHARE_PORT = '5281'
npm run dev
```

Turn its sharing on by writing the colony file directly (the UI for this is Task 8):

```powershell
$key = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:5280/api/state -Headers @{ Origin = 'http://127.0.0.1:5280' } -ContentType 'application/json' -Body (@{ sharing = @{ enabled = $true; key = $key; name = 'Friend' } } | ConvertTo-Json)
Invoke-RestMethod http://127.0.0.1:5280/api/sharing
"http://127.0.0.1:5281/#k=$key"
```

Then in your main page's devtools console (`http://localhost:5274`), add it the same way Task 8's UI will:

```js
const bc = window.botCrossing
// paste the printed link between the quotes
await fetch('/api/state').then((r) => r.json()).then(async (s) => {
  s.neighbors = [{ id: 'nb_check', url: 'http://127.0.0.1:5281', key: 'PASTE_KEY_HERE', slot: 0, addedAt: Date.now() }]
  await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) })
})
location.reload()
```

Expected after reload: a neighbour settlement signed *Friend* beside yours. Clicking one of its bots shows a card titled `Friend · <repo>` with no Open/Viewed/Archive buttons and no progress bar; pressing Enter or A does nothing. Clicking its zone shows a hint line, not the repo sidebar. Holding on its zone or a bot does not lift anything. Pressing `N` never flies to a friend's bot. Stop the friend server (Ctrl+C) and within ~15 s its sign reads `Friend · away` and its bots sit down.

Remove the test neighbour afterwards (same console snippet with `s.neighbors = []`).

- [ ] **Step 8: Commit**

```bash
git add src/main.js src/ui/hud.js src/ui/styles.css
git commit -m "Poll friends with the threads, and keep a neighbour's bot look-don't-touch"
```

---

### Task 8: Settings → Neighbors, and the sidebar list

**Files:**
- Modify: `src/ui/hud.js` (import; `_buildSettings` first group; new `_buildNeighbors`; new `setNeighbors`; TEMPLATE `projects-pane`)
- Modify: `src/main.js` (actions; `neighborModel`, `refreshSharing`, `saveNow`; `boot`; `poll`)
- Modify: `src/ui/styles.css` (append)

**Interfaces:**
- Consumes: `fetchSharing`, `NEIGHBOR_CAP`, `addNeighbor`, `removeNeighbor`, `newShareKey`, `shareLink`, `describeNeighbor` (Task 2); `neighborResults`, `sharingInfo` (Task 7); `colony.neighborSites` (Task 6).
- Produces: `hud.setNeighbors(model)` where `model = { sharing: { enabled, name, link, error }, neighbors: [{ id, name, status, lastSeenAt }], full }`; actions `toggleSharing`, `setShareName`, `rotateShareKey`, `copyShareLink`, `addNeighbor(text) → Promise<boolean>`, `removeNeighbor(id)`, `focusNeighbor(id)`.

- [ ] **Step 1: The settings group**

In `src/ui/hud.js`, add to the imports:

```js
import { describeNeighbor } from '../game/neighbors.js'
```

In `_buildSettings()`, directly after `this.controls = []`, add:

```js
    // Neighbors first: it is the one group here that is about other people, and the one a
    // first-time sharer is looking for.
    body.appendChild(this._buildNeighbors())
```

Add this method directly after `_buildSettings()`:

```js
  /** Settings → Neighbors: share yours, add theirs. Filled in by `setNeighbors`. */
  _buildNeighbors() {
    const g = group('Neighbors')
    g.insertAdjacentHTML(
      'beforeend',
      `<div class="row">
         <div class="label"><span>Share my colony</span><span class="hint">Friends on this Wi-Fi with your link see your repo names and what your bots are doing — never a title, a prompt or a path.</span></div>
         <button type="button" class="toggle" role="switch" aria-label="Share my colony" data-nb="share"></button>
       </div>
       <div class="nb-sharing" data-nb="sharing" hidden>
         <div class="row">
           <div class="label"><span>Your name</span><span class="hint">On your ship's sign, on their map.</span></div>
           <input class="text-input" data-nb="name" maxlength="40" spellcheck="false" />
         </div>
         <div class="nb-link"><code data-nb="link"></code></div>
         <div class="pair">
           <button type="button" class="btn" data-nb="copy">${ICON.copy} Copy link</button>
           <button type="button" class="btn ghost" data-nb="rotate" title="Make a new link — the old one stops working at once">New link</button>
         </div>
         <div class="nb-note" data-nb="note"></div>
       </div>
       <div class="nb-add">
         <input class="text-input" data-nb="paste" placeholder="Paste a friend's link" spellcheck="false" />
         <button type="button" class="btn" data-nb="add">Add</button>
       </div>
       <div class="nb-list" data-nb="list"></div>`
    )
    const el = (name) => g.querySelector(`[data-nb="${name}"]`)
    this.nb = {
      share: el('share'), sharing: el('sharing'), name: el('name'), link: el('link'), copy: el('copy'),
      rotate: el('rotate'), note: el('note'), paste: el('paste'), add: el('add'), list: el('list'),
    }
    const nb = this.nb
    nb.share.addEventListener('click', () => this.actions.toggleSharing?.())
    nb.name.addEventListener('change', () => this.actions.setShareName?.(nb.name.value))
    nb.copy.addEventListener('click', () => this.actions.copyShareLink?.())
    nb.rotate.addEventListener('click', () => this.actions.rotateShareKey?.())
    const add = async () => {
      if (await this.actions.addNeighbor?.(nb.paste.value)) nb.paste.value = ''
    }
    nb.add.addEventListener('click', add)
    nb.paste.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') add()
    })
    return g
  }
```

- [ ] **Step 2: Rendering the model**

Add this method directly after `setLegend(…)`:

```js
  /**
   * Settings → Neighbors and the sidebar's Neighbors list, from one model. Redrawn only when
   * something on it changed — including the minute, because "last seen 4m ago" is on it.
   */
  setNeighbors(model) {
    if (!this.nb || !model) return
    const { sharing, neighbors, full } = model
    const now = Date.now()
    const signature = JSON.stringify([sharing, full, neighbors.map((n) => [n.id, n.name, n.status, describeNeighbor(n.status, n.lastSeenAt, now)])])
    if (this._last.neighbors === signature) return
    this._last.neighbors = signature

    const nb = this.nb
    nb.share.setAttribute('aria-checked', String(sharing.enabled))
    nb.sharing.hidden = !sharing.enabled
    if (document.activeElement !== nb.name) nb.name.value = sharing.name
    nb.link.textContent = sharing.link || (sharing.error ? '—' : 'Opening the share port…')
    nb.copy.disabled = !sharing.link
    nb.note.textContent =
      sharing.error || (IS_WIN ? 'If friends cannot see you, allow Node through Windows Firewall on private networks.' : '')
    nb.note.classList.toggle('err', Boolean(sharing.error))
    nb.add.disabled = full
    nb.paste.disabled = full
    nb.paste.placeholder = full ? 'Six neighbors — remove one to add another' : "Paste a friend's link"

    nb.list.innerHTML = ''
    for (const n of neighbors) {
      const row = document.createElement('div')
      row.className = 'nb-row'
      row.innerHTML =
        `<i class="nb-dot ${n.status}"></i>` +
        `<span class="n">${escapeHtml(n.name)}</span>` +
        `<span class="s">${escapeHtml(describeNeighbor(n.status, n.lastSeenAt, now))}</span>`
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'btn ghost'
      remove.textContent = 'Remove'
      remove.title = `Stop showing ${n.name}'s colony`
      remove.addEventListener('click', () => this.actions.removeNeighbor?.(n.id))
      row.appendChild(remove)
      nb.list.appendChild(row)
    }

    const block = this.$('.neighbors-block')
    block.hidden = neighbors.length === 0
    const side = this.$('.neighbors')
    side.innerHTML = ''
    for (const n of neighbors) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'repo'
      b.title = `Fly to ${n.name}'s colony`
      b.innerHTML =
        `<i class="nb-dot ${n.status}"></i>` +
        `<span class="n">${escapeHtml(n.name)}</span>` +
        `<span class="count">${escapeHtml(describeNeighbor(n.status, n.lastSeenAt, now))}</span>`
      b.addEventListener('click', () => this.actions.focusNeighbor?.(n.id))
      side.appendChild(b)
    }
  }
```

In `TEMPLATE`, inside `<div class="projects-pane">`, directly after the closing `</div>` of `<div class="hidden-block" hidden>…</div>`, add:

```html
      <div class="neighbors-block" hidden>
        <div class="sec-head"><span>Neighbors</span></div>
        <div class="neighbors"></div>
      </div>
```

- [ ] **Step 3: Styles**

Append to `src/ui/styles.css`:

```css
/* ── neighbors ─────────────────────────────────────────────────────────────── */

.text-input {
  height: 30px;
  min-width: 0;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  pointer-events: auto;
}

.text-input:focus-visible {
  outline: 2px solid var(--accent);
}

.nb-link code {
  display: block;
  margin: 4px 0 8px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  font-size: 11.5px;
  color: var(--muted);
  overflow-wrap: anywhere;
  user-select: all;
}

.nb-note {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--dim);
}

.nb-note.err {
  color: var(--red);
}

.nb-add {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.nb-add .text-input {
  flex: 1;
}

.nb-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 2px;
  font-size: 13px;
}

.nb-row .n {
  flex: none;
}

.nb-row .s {
  flex: 1;
  min-width: 0;
  color: var(--dim);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--dim);
}

.nb-dot.online {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
}

.nb-dot.away {
  background: var(--amber);
}

.nb-dot.bad-key,
.nb-dot.needs-update {
  background: var(--red);
}

.side .neighbors {
  padding: 0 9px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
```

- [ ] **Step 4: The actions and the model in main.js**

In `src/main.js`, add `fetchSharing,` to the `./game/api.js` import list (after `fetchNeighbors,`), and widen the neighbors import to:

```js
import { NEIGHBOR_CAP, addNeighbor, hydrateNeighbors, newShareKey, removeNeighbor, shareLink } from './game/neighbors.js'
```

Directly after the `let neighborResults = []` line from Task 7, add:

```js
/** Whether our own share port is open, and on what address — `GET /api/sharing`. */
let sharingInfo = null
```

Then add these entries to the `actions` object (directly before its closing `}` — after `progressFor`):

```js
  // ── neighbors ──────────────────────────────────────────────────────────────────────

  /** On makes a key if there is none; off keeps it, so turning back on reuses the same link. */
  toggleSharing: async () => {
    const current = state.sharing || { enabled: false, key: '', name: '' }
    const enabled = !current.enabled
    state.sharing = {
      enabled,
      key: enabled && !/^[0-9a-f]{32}$/.test(current.key || '') ? newShareKey() : current.key || '',
      name: current.name || sharingInfo?.defaultName || '',
    }
    await saveNow()
    await refreshSharing()
  },

  setShareName: (name) => {
    state.sharing = { ...(state.sharing || {}), name: String(name || '').trim().slice(0, 40) }
    queueSave()
    hud.setNeighbors(neighborModel())
  },

  rotateShareKey: async () => {
    if (!state.sharing?.enabled) return
    state.sharing = { ...state.sharing, key: newShareKey() }
    await saveNow()
    await refreshSharing()
    hud.toast('New link made — the old one no longer works')
  },

  copyShareLink: async () => {
    const link = neighborModel().sharing.link
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      hud.toast('Link copied')
    } catch {
      const copied = copyFallback(link)
      hud.toast(copied ? 'Link copied' : 'Could not reach the clipboard', copied ? '' : 'err')
    }
  },

  addNeighbor: async (text) => {
    const { list, error } = addNeighbor(state.neighbors || [], text)
    if (error) {
      hud.toast(error, 'err')
      return false
    }
    state.neighbors = list
    await saveNow()
    await poll() // reach them now rather than on the next tick
    hud.toast('Neighbor added — they appear once their machine answers')
    return true
  },

  removeNeighbor: async (id) => {
    state.neighbors = removeNeighbor(state.neighbors || [], id)
    neighborResults = neighborResults.filter((r) => r.id !== id)
    await saveNow()
    applyThreads(threads)
    hud.setNeighbors(neighborModel())
  },

  focusNeighbor: (id) => {
    const site = colony.neighborSites.find((s) => s.id === id)
    if (!site) {
      hud.hint('Not reached yet — nothing to fly to')
      return
    }
    if (rig.following) select(null, {})
    rig.focus(new THREE.Vector3(site.x, 0, site.z), { distance: Math.max(30, site.r * 2.2) })
  },
```

Add these functions directly after `queueSave()`:

```js
/** Save now rather than in half a second: the share port follows the file, and the page asks about it next. */
async function saveNow() {
  clearTimeout(pendingSave)
  try {
    state = await saveState(state)
  } catch (err) {
    hud.toast(err.message || 'Could not save the colony', 'err')
  }
}

/** Ask our own server whether the share port is open, then redraw the panel. */
async function refreshSharing() {
  sharingInfo = await fetchSharing().catch(() => null)
  hud.setNeighbors(neighborModel())
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname
  } catch {
    return 'Neighbor'
  }
}

/** Everything Settings → Neighbors and the sidebar list show, from state plus the last fetch. */
function neighborModel() {
  const sharing = state.sharing || {}
  const info = sharingInfo
  const byId = new Map(neighborResults.map((r) => [r.id, r]))
  const noAddress = sharing.enabled && info?.listening && !info.lanAddress
  return {
    sharing: {
      enabled: Boolean(sharing.enabled),
      name: sharing.name || info?.defaultName || '',
      error: sharing.enabled ? info?.error || (noAddress ? 'No Wi-Fi address found on this machine' : '') : '',
      link: sharing.enabled && info?.listening ? shareLink({ lanAddress: info.lanAddress, port: info.port, key: sharing.key }) : '',
    },
    neighbors: (state.neighbors || []).map((n) => {
      const r = byId.get(n.id)
      return { id: n.id, name: r?.snapshot?.name || hostOf(n.url), status: r?.status || 'unreachable', lastSeenAt: r?.lastSeenAt || 0 }
    }),
    full: (state.neighbors || []).length >= NEIGHBOR_CAP,
  }
}
```

In `poll()`, directly after `applyThreads(res.threads || [])`, add:

```js
    hud.setNeighbors(neighborModel())
```

In `boot()`, directly before `await poll()`, add:

```js
  // The settings panel needs the share address before it can show a link.
  refreshSharing()
```

- [ ] **Step 5: Run the suites and the build**

Run: `npm test` → only the 2 baseline failures. Run: `npx vite build` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/ui/hud.js src/ui/styles.css src/main.js
git commit -m "Settings → Neighbors and a Neighbors list in the sidebar"
```

---

### Task 9: Two colonies, end to end

No new code unless this finds something. Uses two throwaway instances so your real colony is never touched.

- [ ] **Step 1: Start two instances**

Window A:

```powershell
$env:BOT_CROSSING_DATA = "$env:TEMP\bc-a"; $env:PORT = '5280'; $env:BOT_CROSSING_SHARE_PORT = '5281'; npm run dev
```

Window B:

```powershell
$env:BOT_CROSSING_DATA = "$env:TEMP\bc-b"; $env:PORT = '5282'; $env:BOT_CROSSING_SHARE_PORT = '5283'; npm run dev
```

If Windows asks whether Node may use the network, allow private networks.

- [ ] **Step 2: Share and add, through the UI only**

Open `http://localhost:5280` (A) and `http://localhost:5282` (B). In each: `S` → Neighbors → *Share my colony* on → type a name (`Alice` in A, `Bob` in B) → *Copy link*. Paste A's link into B's *Add neighbor* and B's into A's.

Expected in both: within a poll (≤15 s) the friend's settlement appears beside yours with their name on their ship; Settings shows the friend's row with a green dot and *here now*; the sidebar shows a Neighbors section with the friend; clicking it flies there.

- [ ] **Step 3: Check what crossed the wire**

In a third window, with A's key from its link:

```powershell
$snap = Invoke-RestMethod http://127.0.0.1:5281/share/v1/colony -Headers @{ Authorization = 'Bearer PASTE_A_KEY' }
$snap.threads[0] | Format-List
($snap | ConvertTo-Json -Depth 6) -match 'Users|\\\\|claude-code:'
```

Expected: each thread shows exactly `id project harness harnessName running unread hasError prState lastActivityAt createdAt sizeBucket isErrand`; the `-match` line prints `False`.

- [ ] **Step 4: Check the failure states**

1. In B: *New link*. Expected in A within ~15 s: Bob's row turns red, *link no longer valid*; Bob's settlement stays drawn, sign reads `Bob · away`.
2. In A: remove Bob, paste Bob's new link. Expected: green again.
3. Stop B (Ctrl+C). Expected in A: Bob's row amber, *away · last seen …*; Bob's bots sit down; sign reads `Bob · away`.
4. Start B again. Expected: back to *here now*, bots get up.
5. In A, click one of Bob's bots: card titled `Bob · <repo>`, no buttons, no progress bar; `Enter`, `A`, `V` do nothing; hold on it: nothing lifts.
6. In A, press `0`: the view returns to Alice's colony. Press `N`: it only ever flies to Alice's own waiting bots.

- [ ] **Step 5: Check your own colony did not change**

Close A and B. Open your real colony (`http://localhost:5274`, after `npm run dev` there picks up the new code). Expected: zones exactly where they were, same counts, no neighbours (you have none saved), Settings → Neighbors present with sharing off.

- [ ] **Step 6: Clean up**

```powershell
Remove-Item -Recurse -Force "$env:TEMP\bc-a", "$env:TEMP\bc-b"
```

If any step above failed, fix it under `superpowers:systematic-debugging`, add a regression test where the fix is in a node-testable module, and commit with a message naming what Step N found.

---

## Self-review notes

- Spec §1 browser side (toggle, key generated in browser, link, rotate, name, defaultName, port error, firewall hint) → Task 8 (+ Task 2 for the key and link helpers).
- Spec §2 adding (lowest free slot, cap 6, duplicate refusal, rows with status and remove) → Tasks 2 and 8; the page polling `/api/neighbors` on `poll()` → Task 7.
- Spec §3 placement (slots, two rings, sticky, coast landward, islands via footprint) → Tasks 1 and 6; neighbour plots in the one Colony → Task 6; flat ground, craters, ground size → Task 5; nav and camera reach, ship facing → Task 3; bots' doors and budget → Task 4; read-only card, zone hint, sign, sidebar list, `N`/`0` home-only, no drag, no chime → Tasks 6–8 (the chime needs no change: `chimeForNewWaiting` only ever iterates home `list`).
- Spec §4 failure rows → server statuses (Part 1) rendered by `describeNeighbor` (Task 2) in Task 8; away bots sit via `hydrateNeighbors` (Task 2); sign text in Task 6; 7-day drop is Part 1.
- Spec §5 placement tests → Task 1; home colony unchanged → every task's `npm test`; end to end → Task 9.
