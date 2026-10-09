# Neighbors, part 1: the server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Bot Crossing server share a redacted, read-only snapshot of its colony on the LAN behind a key, and fetch its friends' snapshots for the page.

**Architecture:** A second `http.Server` (the *share port*, default 5275) answers exactly `GET /share/v1/colony` with a Bearer key, built from the existing scan by an allowlist redactor. The existing local API gains `GET /api/sharing` (status for the settings UI) and `GET /api/neighbors` (server-side fetch of every saved friend, validated, last-good cached). The page never talks to another machine. Part 2 (`2026-10-09-neighbors-2-world.md`) draws what this returns.

**Tech Stack:** Node 22 (`node:http`, `node:crypto`, global `fetch`, `AbortSignal.timeout`), `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-neighbors-design.md`

## Global Constraints

- `data/colony.json` stays the only file the project writes. Sharing config and the friends list live in it, under `sharing` and `neighbors`.
- The browser stays the only writer of `colony.json` (whole-file `PUT /api/state`); the server only reads it.
- Share port default **5275**; overridable with `BOT_CROSSING_SHARE_PORT` (a value of `0` means "any free port", used by tests) and `BOT_CROSSING_SHARE_HOST` (default `0.0.0.0`).
- Share key: 32 lowercase hex chars (128 bits). Compared with `crypto.timingSafeEqual`.
- Shared thread fields are an **allowlist**: `id` (`n:` + 16 hex of `sha256(key + ':' + thread.id)`), `project`, `harness`, `harnessName`, `running`, `unread`, `hasError`, `prState`, `lastActivityAt` and `createdAt` (floored to the minute), `sizeBucket` (`floor(log2(sizeBytes))`, 0–40), `isErrand`. Never `title`, `preview`, `projectPath`, `cwd`, `worktree`, `gitBranch`, `model`, `ref`, real `id`.
- Snapshot version `v: 1`. Validation caps: 200 projects, 500 threads, 120 chars per string, 64 cells per project.
- Neighbor fetch timeout 2 s. Statuses: `online`, `away`, `bad-key`, `needs-update`, `unreachable`. A last-good snapshot older than 7 days is dropped.
- Rate limit on the share port: 30 requests per minute per remote address, then 429.
- At most 6 neighbors.
- Baseline before starting: `npm test` reports **145 pass, 2 fail** on Windows. The two failures (`a running subagent is reported with the brief…`, `asked for a terminal on Windows…`) predate this work; every task must leave exactly those two failing and nothing else.

---

### Task 1: A three-free status module

`statusFor` lives in `src/game/colony.js`, which imports three.js and the astronaut renderer and so cannot load in Node. The share snapshot needs the same "is this repo dormant" rule on the server, so the rule moves to its own pure module and `colony.js` re-exports it.

**Files:**
- Create: `src/game/status.js`
- Modify: `src/game/colony.js:53` (remove `STALE_MS`), `src/game/colony.js:80-88` (remove `statusFor`), imports at top
- Test: `test/status.test.mjs`

**Interfaces:**
- Produces: `statusFor(thread, now?) → 'blocked'|'working'|'celebrating'|'waiting'|'sleeping'|'idle'`, `STALE_MS`, `allSleeping(list, now?) → boolean` from `src/game/status.js`. `src/game/colony.js` still exports `statusFor` (main.js imports it from there).

- [ ] **Step 1: Write the failing test**

```js
// test/status.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { STALE_MS, allSleeping, statusFor } from '../src/game/status.js'

const now = 10 * STALE_MS

test('the precedence is errored, running, merged, unread, stale, idle', () => {
  const t = { hasError: true, running: true, prState: 'MERGED', unread: true, lastActivityAt: 0 }
  assert.equal(statusFor(t, now), 'blocked')
  assert.equal(statusFor({ ...t, hasError: false }, now), 'working')
  assert.equal(statusFor({ ...t, hasError: false, running: false }, now), 'celebrating')
  assert.equal(statusFor({ unread: true, lastActivityAt: 0 }, now), 'waiting')
  assert.equal(statusFor({ lastActivityAt: 0 }, now), 'sleeping')
  assert.equal(statusFor({ lastActivityAt: now - 1000 }, now), 'idle')
})

test('a repo is dormant only when every thread in it sleeps', () => {
  assert.equal(allSleeping([{ lastActivityAt: 0 }, { lastActivityAt: 0 }], now), true)
  assert.equal(allSleeping([{ lastActivityAt: 0 }, { lastActivityAt: now }], now), false)
  assert.equal(allSleeping([], now), false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/status.test.mjs`
Expected: FAIL — `Cannot find module '…/src/game/status.js'`

- [ ] **Step 3: Create the module**

```js
// src/game/status.js
/**
 * Thread → behaviour, with nothing but plain data in and a word out.
 *
 * Lives apart from colony.js because the server needs the same rule: a shared snapshot folds
 * dormant repos away exactly as the sharer's own map does, and colony.js cannot load in Node.
 */

export const STALE_MS = 3 * 24 * 60 * 60 * 1000

/** Thread → behaviour. First match wins, exactly like the board's auto-sort. */
export function statusFor(thread, now = Date.now()) {
  if (thread.hasError) return 'blocked'
  if (thread.running) return 'working'
  if (thread.prState === 'MERGED') return 'celebrating'
  if (thread.unread) return 'waiting'
  if (now - thread.lastActivityAt > STALE_MS) return 'sleeping'
  return 'idle'
}

/** The dormant fold's line, drawn at the repo: every thread in it asleep. */
export function allSleeping(list, now = Date.now()) {
  return list.length > 0 && list.every((t) => statusFor(t, now) === 'sleeping')
}
```

- [ ] **Step 4: Point colony.js at it**

In `src/game/colony.js`, delete line 53 (`const STALE_MS = 3 * 24 * 60 * 60 * 1000`) and delete the whole `statusFor` function with its one-line comment (lines 80–88). Then add, directly under the existing `import { liveThreadsForColony } from './hidden-projects.js'` line:

```js
import { statusFor } from './status.js'

export { statusFor }
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/status.test.mjs`
Expected: PASS (2 tests)

Run: `npm test`
Expected: 147 pass, 2 fail (the two baseline failures).

Run: `npx vite build`
Expected: build succeeds (proves the browser bundle still resolves `statusFor`).

- [ ] **Step 6: Commit**

```bash
git add src/game/status.js src/game/colony.js test/status.test.mjs
git commit -m "Move statusFor into a module the server can load"
```

---

### Task 2: `sharing` and `neighbors` in the colony file

**Files:**
- Modify: `server/api.mjs:52-63` (`emptyState`), `server/api.mjs:68-86` (`readState`), `server/api.mjs:105-117` (`writeState`)
- Modify: `src/game/merge-state.js:116-131` (`mergeState`)
- Test: `test/state.test.mjs` (append)

**Interfaces:**
- Produces: state shape gains
  `sharing: { enabled: boolean, key: string, name: string }` and
  `neighbors: Array<{ id: string, url: string, key: string, slot: number, addedAt: number }>` (max 6).
  `mergeState` keeps both.

- [ ] **Step 1: Write the failing tests**

Append to `test/state.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/state.test.mjs`
Expected: the five new tests FAIL (`state.sharing` is `undefined`; `out.neighbors` is `undefined`).

- [ ] **Step 3: Teach the server the two fields**

In `server/api.mjs`, add these helpers directly under the existing `const asArray = …` line (line 66):

```js
const KEY_HEX = /^[0-9a-f]{32}$/

/** Sharing is off unless the file says otherwise, and a key that is not 32 hex chars is no key. */
function asSharing(v) {
  const o = asObject(v)
  return {
    enabled: o.enabled === true,
    key: typeof o.key === 'string' && KEY_HEX.test(o.key) ? o.key : '',
    name: typeof o.name === 'string' ? o.name.slice(0, 40) : '',
  }
}

/** At most six friends, each with somewhere to fetch from and a slot to stand in. */
function asNeighbors(v) {
  return asArray(v)
    .filter((n) => n && typeof n === 'object' && typeof n.id === 'string' && n.id && typeof n.url === 'string')
    .map((n) => ({
      id: n.id,
      url: n.url,
      key: typeof n.key === 'string' ? n.key : '',
      slot: Number.isInteger(n.slot) ? n.slot : 0,
      addedAt: Number(n.addedAt) || 0,
    }))
    .slice(0, 6)
}
```

Note `asObject`/`asArray` are declared as `const` arrow functions above this point, so these helpers must sit *below* line 66.

In `emptyState()`, add two entries after `settings: null,`:

```js
  sharing: { enabled: false, key: '', name: '' },
  neighbors: [],
```

In `readState()`, add after the `settings:` line inside the returned object:

```js
      sharing: asSharing(raw.sharing),
      neighbors: asNeighbors(raw.neighbors),
```

In `writeState(next)`, add after the `settings:` line inside `const state = {…}`:

```js
    sharing: asSharing(next.sharing),
    neighbors: asNeighbors(next.neighbors),
```

- [ ] **Step 4: Teach the merge the two fields**

In `src/game/merge-state.js`, add above `export function mergeState`:

```js
/**
 * A value that only ever changes as a whole — `sharing` is a toggle, a key and a name that go
 * together. Whichever tab changed it since the base wins; if neither did, the disk copy stands.
 */
function mergeWhole(base, local, remote) {
  return sameValue(base, local) ? remote : local
}

/**
 * `neighbors` is a list of records with ids. Merged as a map keyed on id, so a friend added in
 * each tab survives and a friend removed in this tab stays removed, then back to a list in slot
 * order so the file does not churn.
 */
function mergeById(base, local, remote) {
  const byId = (list) => Object.fromEntries(asArray(list).filter((n) => n && n.id).map((n) => [n.id, n]))
  const merged = mergeMap(byId(base), byId(local), byId(remote))
  return Object.values(merged).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || String(a.id).localeCompare(String(b.id)))
}
```

In `mergeState`, add two lines after `settings: …,`:

```js
    sharing: mergeWhole(b.sharing, l.sharing, r.sharing) ?? null,
    neighbors: mergeById(b.neighbors, l.neighbors, r.neighbors),
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/state.test.mjs`
Expected: PASS (all, including the five new ones)

Run: `npm test`
Expected: 152 pass, 2 fail (baseline failures only)

- [ ] **Step 6: Commit**

```bash
git add server/api.mjs src/game/merge-state.js test/state.test.mjs
git commit -m "Keep sharing and the neighbors list in the colony file"
```

---

### Task 3: The redacted snapshot

**Files:**
- Create: `server/share-snapshot.mjs`
- Test: `test/share-snapshot.test.mjs`

**Interfaces:**
- Consumes: `withErrands` (`src/game/errands.js`), `liveThreadsForColony` (`src/game/hidden-projects.js`), `allSleeping` (Task 1).
- Produces:
  - `SHARE_VERSION = 1`
  - `sharedId(key: string, id: string) → string` — `'n:' + 16 hex`
  - `sizeBucket(bytes: number) → integer 0..40`
  - `toShared(thread, key) → SharedThread`
  - `buildSnapshot({ threads, state, now?, name? }) → { v, name, generatedAt, projects: [{ name, cells: [[q,r]] }], threads: SharedThread[] }`

- [ ] **Step 1: Write the failing tests**

```js
// test/share-snapshot.test.mjs
/**
 * What leaves this machine when sharing is on. Every way of getting this wrong is a way of
 * publishing somebody's prompts to the office, so the test is written as a leak hunt: plant
 * secrets in every private field and look for them anywhere in the output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { STALE_MS } from '../src/game/status.js'
import { SHARE_VERSION, buildSnapshot, sharedId, sizeBucket } from '../server/share-snapshot.mjs'

const KEY = '0123456789abcdef0123456789abcdef'
const NOW = 100 * STALE_MS

const secretThread = (n, extra = {}) => ({
  id: `claude-code:SECRET-ID-${n}`,
  title: `SECRET-TITLE-${n}`,
  preview: `SECRET-PROMPT-${n}`,
  project: 'bot-crossing',
  projectPath: `C:\\Users\\SECRET-USER\\SECRET-PATH-${n}`,
  cwd: `/home/SECRET-CWD-${n}`,
  worktree: `SECRET-WORKTREE-${n}`,
  gitBranch: `SECRET-BRANCH-${n}`,
  model: `SECRET-MODEL-${n}`,
  ref: { sessionId: `SECRET-REF-${n}` },
  harness: 'claude-code',
  harnessName: 'Claude Code',
  running: true,
  unread: false,
  hasError: false,
  prState: '',
  lastActivityAt: NOW - 90_123,
  createdAt: NOW - 500_456,
  sizeBytes: 5000,
  ...extra,
})

const baseState = (extra = {}) => ({
  sharing: { enabled: true, key: KEY, name: 'Mark' },
  archived: [],
  hiddenProjects: [],
  viewedAt: {},
  plots: { 'bot-crossing': [[0, 0], [1, 0]] },
  settings: null,
  ...extra,
})

test('no private field leaves the machine', () => {
  const threads = [
    secretThread(1, { subagents: [{ id: 'sub1', task: 'SECRET-TASK-1', lastActivityAt: NOW }] }),
    secretThread(2),
  ]
  const out = JSON.stringify(buildSnapshot({ threads, state: baseState(), now: NOW }))
  assert.doesNotMatch(out, /SECRET/)
  assert.doesNotMatch(out, /claude-code:/, 'real thread ids never appear')
})

test('the snapshot carries the shape and status a friend needs', () => {
  const snap = buildSnapshot({ threads: [secretThread(1)], state: baseState(), now: NOW })
  assert.equal(snap.v, SHARE_VERSION)
  assert.equal(snap.name, 'Mark')
  assert.deepEqual(snap.projects, [{ name: 'bot-crossing', cells: [[0, 0], [1, 0]] }])
  const [t] = snap.threads
  assert.deepEqual(Object.keys(t).sort(), [
    'createdAt', 'harness', 'harnessName', 'hasError', 'id', 'isErrand', 'lastActivityAt',
    'prState', 'project', 'running', 'sizeBucket', 'unread',
  ])
  assert.equal(t.id, sharedId(KEY, 'claude-code:SECRET-ID-1'))
  assert.match(t.id, /^n:[0-9a-f]{16}$/)
  assert.equal(t.lastActivityAt % 60000, 0, 'floored to the minute')
  assert.equal(t.createdAt % 60000, 0)
  assert.equal(t.sizeBucket, 12) // floor(log2(5000))
})

test('a shared id is stable for one key and changes when the key rotates', () => {
  assert.equal(sharedId(KEY, 'x'), sharedId(KEY, 'x'))
  assert.notEqual(sharedId(KEY, 'x'), sharedId('f'.repeat(32), 'x'))
})

test('size buckets are a clamped log2', () => {
  assert.equal(sizeBucket(0), 0)
  assert.equal(sizeBucket(1), 0)
  assert.equal(sizeBucket(1024), 10)
  assert.equal(sizeBucket(2 ** 60), 40)
  assert.equal(sizeBucket(undefined), 0)
})

test('archived threads and hidden repos are not shared', () => {
  const threads = [secretThread(1), secretThread(2, { project: 'private-repo' })]
  const state = baseState({ archived: ['claude-code:SECRET-ID-1'], hiddenProjects: ['private-repo'] })
  const snap = buildSnapshot({ threads, state, now: NOW })
  assert.deepEqual(snap.threads, [])
  assert.deepEqual(snap.projects, [])
})

test('dormant repos fold away for friends exactly as they do at home', () => {
  const asleep = secretThread(2, { project: 'old-repo', running: false, lastActivityAt: 0 })
  const snap = buildSnapshot({ threads: [secretThread(1), asleep], state: baseState(), now: NOW })
  assert.deepEqual(snap.projects.map((p) => p.name), ['bot-crossing'])
  const shown = buildSnapshot({ threads: [secretThread(1), asleep], state: baseState({ settings: { hideDormant: false } }), now: NOW })
  assert.deepEqual(shown.projects.map((p) => p.name).sort(), ['bot-crossing', 'old-repo'])
})

test('a thread you marked viewed does not wave at your friends either', () => {
  const t = secretThread(1, { running: false, unread: true, lastActivityAt: NOW - 120_000 })
  const snap = buildSnapshot({ threads: [t], state: baseState({ viewedAt: { [t.id]: NOW } }), now: NOW })
  assert.equal(snap.threads[0].unread, false)
})

test('errands are shared as their own bots, marked as errands', () => {
  const t = secretThread(1, { subagents: [{ id: 's', task: 'SECRET-TASK', lastActivityAt: NOW }] })
  const snap = buildSnapshot({ threads: [t], state: baseState(), now: NOW })
  assert.equal(snap.threads.length, 2)
  assert.deepEqual(snap.threads.map((x) => x.isErrand), [false, true])
})

test('a repo with no saved layout is shared with empty cells, and junk cells are dropped', () => {
  const state = baseState({ plots: { 'bot-crossing': [[0, 0], ['x', 1], [1.5, 2], [2, 2]] } })
  const snap = buildSnapshot({ threads: [secretThread(1), secretThread(2, { project: 'new' })], state, now: NOW })
  assert.deepEqual(snap.projects, [
    { name: 'bot-crossing', cells: [[0, 0], [2, 2]] },
    { name: 'new', cells: [] },
  ])
})

test('the name falls back to the one passed in, then to Neighbor', () => {
  const noName = baseState({ sharing: { enabled: true, key: KEY, name: '' } })
  assert.equal(buildSnapshot({ threads: [], state: noName, now: NOW, name: 'jjt' }).name, 'jjt')
  assert.equal(buildSnapshot({ threads: [], state: noName, now: NOW }).name, 'Neighbor')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/share-snapshot.test.mjs`
Expected: FAIL — `Cannot find module '…/server/share-snapshot.mjs'`

- [ ] **Step 3: Write the module**

```js
// server/share-snapshot.mjs
/**
 * What a friend sees of this colony: its shape and what its bots are doing, nothing more.
 *
 * Built field by field from a fixed list rather than by deleting the private ones. A field added
 * to the Thread shape next year is private until somebody adds it *here*, on purpose — a
 * denylist would publish it the day it landed. See DECISIONS.md.
 */
import crypto from 'node:crypto'
import { withErrands } from '../src/game/errands.js'
import { liveThreadsForColony } from '../src/game/hidden-projects.js'
import { allSleeping } from '../src/game/status.js'

export const SHARE_VERSION = 1

/** A pull request's state is one short word; anything else is not passed on. */
const WORD = /^[A-Za-z]{1,12}$/
const MAX_CELLS = 64

/**
 * Unlinkable to the real session id, stable for as long as the key is — so a friend's map does
 * not reshuffle every poll — and different the moment the key rotates.
 */
export function sharedId(key, id) {
  return 'n:' + crypto.createHash('sha256').update(`${key}:${id}`).digest('hex').slice(0, 16)
}

/** Building size travels as a power of two, which is all a log-scale skyline needs. */
export function sizeBucket(bytes) {
  const b = Number(bytes) || 0
  if (b < 1) return 0
  return Math.min(40, Math.max(0, Math.floor(Math.log2(b))))
}

const toMinute = (t) => Math.floor((Number(t) || 0) / 60000) * 60000

export function toShared(thread, key) {
  return {
    id: sharedId(key, thread.id),
    project: String(thread.project || 'unknown'),
    harness: String(thread.harness || ''),
    harnessName: String(thread.harnessName || ''),
    running: thread.running === true,
    unread: thread.unread === true,
    hasError: thread.hasError === true,
    prState: WORD.test(String(thread.prState || '')) ? String(thread.prState) : '',
    lastActivityAt: toMinute(thread.lastActivityAt),
    createdAt: toMinute(thread.createdAt),
    sizeBucket: sizeBucket(thread.sizeBytes),
    isErrand: Boolean(thread.parentId),
  }
}

/** A saved zone footprint, with anything that is not a pair of whole numbers dropped. */
function cleanCells(cells) {
  if (!Array.isArray(cells)) return []
  return cells
    .filter((c) => Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]))
    .slice(0, MAX_CELLS)
    .map(([q, r]) => [q, r])
}

/**
 * The snapshot. Mirrors what the sharer's own map draws — errands expanded, viewed threads not
 * waving, archived threads and hidden repos gone, dormant repos folded away unless the sharer
 * turned that off — so a friend sees what the sharer sees, minus the words.
 */
export function buildSnapshot({ threads, state, now = Date.now(), name = '' }) {
  const key = state.sharing?.key || ''
  const viewed = state.viewedAt || {}
  const expanded = withErrands(threads).map((t) => {
    const at = viewed[t.id]
    return at && t.lastActivityAt <= at ? { ...t, unread: false } : t
  })
  const live = liveThreadsForColony(expanded, new Set(state.archived || []), new Set(state.hiddenProjects || []))

  const byProject = new Map()
  for (const t of live) {
    const k = t.project || 'unknown'
    if (!byProject.has(k)) byProject.set(k, [])
    byProject.get(k).push(t)
  }
  // Same rule as Colony.setThreads, including never folding away everything.
  if (state.settings?.hideDormant !== false) {
    const dormant = [...byProject].filter(([, list]) => allSleeping(list, now)).map(([n]) => n)
    if (dormant.length < byProject.size) for (const n of dormant) byProject.delete(n)
  }

  const plots = state.plots || {}
  const names = [...byProject.keys()].sort((a, b) => a.localeCompare(b))
  return {
    v: SHARE_VERSION,
    name: String(state.sharing?.name || name || 'Neighbor').slice(0, 40),
    generatedAt: now,
    projects: names.map((n) => ({ name: n, cells: cleanCells(plots[n]) })),
    threads: names.flatMap((n) => byProject.get(n).map((t) => toShared(t, key))),
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/share-snapshot.test.mjs`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add server/share-snapshot.mjs test/share-snapshot.test.mjs
git commit -m "Build the redacted colony snapshot friends are allowed to see"
```

---

### Task 4: The share listener

**Files:**
- Create: `server/share.mjs`
- Test: `test/share.test.mjs`

**Interfaces:**
- Produces:
  - `SHARE_PATH = '/share/v1/colony'`
  - `keysMatch(given: string, expected: string) → boolean`
  - `createShareService({ host, port, getKey: () => Promise<string>, snapshot: () => Promise<object> }) → { sync(enabled: boolean): Promise<void>, status(): { listening: boolean, port: number, error: string }, close(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

```js
// test/share.test.mjs
/**
 * The one listener in this project that answers anything but its own page. Every test here is
 * about what it refuses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SHARE_PATH, createShareService, keysMatch } from '../server/share.mjs'

const KEY = 'abcdefabcdefabcdefabcdefabcdefab'

async function withService(run, { key = KEY } = {}) {
  const service = createShareService({
    host: '127.0.0.1',
    port: 0,
    getKey: async () => key,
    snapshot: async () => ({ v: 1, name: 'Mark', projects: [], threads: [] }),
  })
  await service.sync(true)
  const base = `http://127.0.0.1:${service.status().port}`
  try {
    return await run({ service, base })
  } finally {
    await service.close()
  }
}

const auth = (key) => ({ headers: { Authorization: `Bearer ${key}` } })

test('keys are compared whole, and an empty expected key matches nothing', () => {
  assert.equal(keysMatch(KEY, KEY), true)
  assert.equal(keysMatch(KEY.slice(0, 31), KEY), false)
  assert.equal(keysMatch('', ''), false)
  assert.equal(keysMatch(undefined, KEY), false)
})

test('the right key gets the snapshot', async () => {
  await withService(async ({ base }) => {
    const res = await fetch(base + SHARE_PATH, auth(KEY))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).name, 'Mark')
  })
})

test('no key, or the wrong one, is refused', async () => {
  await withService(async ({ base }) => {
    assert.equal((await fetch(base + SHARE_PATH)).status, 401)
    assert.equal((await fetch(base + SHARE_PATH, auth('0'.repeat(32)))).status, 401)
  })
})

test('nothing but the one path and method is answered', async () => {
  await withService(async ({ base }) => {
    for (const p of ['/', '/api/state', '/api/threads', '/api/open', '/share/v2/colony', SHARE_PATH + '/x']) {
      assert.equal((await fetch(base + p, auth(KEY))).status, 404, p)
    }
    assert.equal((await fetch(base + SHARE_PATH, { method: 'POST', ...auth(KEY) })).status, 404)
  })
})

test('sharing with no key configured refuses everyone', async () => {
  await withService(async ({ base }) => {
    assert.equal((await fetch(base + SHARE_PATH, auth(''))).status, 401)
  }, { key: '' })
})

test('a caller hammering the port is slowed down', async () => {
  await withService(async ({ base }) => {
    const codes = []
    for (let i = 0; i < 32; i++) codes.push((await fetch(base + SHARE_PATH, auth('0'.repeat(32)))).status)
    assert.equal(codes.filter((c) => c === 401).length, 30)
    assert.equal(codes.at(-1), 429)
  })
})

test('turning sharing off closes the port', async () => {
  const service = createShareService({ host: '127.0.0.1', port: 0, getKey: async () => KEY, snapshot: async () => ({}) })
  await service.sync(true)
  const { port } = service.status()
  assert.equal(service.status().listening, true)
  await service.sync(false)
  assert.equal(service.status().listening, false)
  await assert.rejects(fetch(`http://127.0.0.1:${port}${SHARE_PATH}`, auth(KEY)))
})

test('a port already in use is reported, not thrown', async () => {
  await withService(async ({ service }) => {
    const taken = service.status().port
    const second = createShareService({ host: '127.0.0.1', port: taken, getKey: async () => KEY, snapshot: async () => ({}) })
    await second.sync(true)
    const status = second.status()
    assert.equal(status.listening, false)
    assert.match(status.error, new RegExp(String(taken)))
    await second.close()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/share.test.mjs`
Expected: FAIL — `Cannot find module '…/server/share.mjs'`

- [ ] **Step 3: Write the module**

```js
// server/share.mjs
/**
 * The share port: the one listener in Bot Crossing that answers machines other than this one.
 *
 * A separate `http.Server` with its own handler, not the API middleware behind a different
 * guard — so nothing that can open a thread, start a session or write the colony file is
 * reachable from it, by construction rather than by a check someone could get wrong later.
 * It exists only while sharing is on, and answers exactly one request.
 */
import http from 'node:http'
import crypto from 'node:crypto'

export const SHARE_PATH = '/share/v1/colony'

const RATE_WINDOW_MS = 60_000
const RATE_MAX = 30

/** Constant-time on equal lengths; an empty expected key means sharing has no key, so nobody. */
export function keysMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')
  return m ? m[1] : ''
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function createShareService({ host, port, getKey, snapshot }) {
  let server = null
  let status = { listening: false, port: 0, error: '' }
  let chain = Promise.resolve()
  const hits = new Map()

  /** Counted before the key is looked at, so guessing keys is as slow as everything else. */
  function limited(addr) {
    const now = Date.now()
    const h = hits.get(addr)
    if (!h || now - h.start > RATE_WINDOW_MS) {
      hits.set(addr, { start: now, count: 1 })
      return false
    }
    h.count += 1
    return h.count > RATE_MAX
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://share.local')
    if (req.method !== 'GET' || url.pathname !== SHARE_PATH) return send(res, 404, { error: 'Not found' })
    if (limited(req.socket.remoteAddress || '')) return send(res, 429, { error: 'Too many requests' })
    if (!keysMatch(bearer(req), await getKey())) return send(res, 401, { error: 'Wrong or missing key' })
    return send(res, 200, await snapshot())
  }

  function open() {
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch(() => send(res, 500, { error: 'Could not build the colony snapshot' }))
      })
      s.once('error', (err) => {
        status = {
          listening: false,
          port: 0,
          error: err.code === 'EADDRINUSE' ? `Couldn't open port ${port} — something else is using it` : String(err.message || err),
        }
        resolve()
      })
      s.listen(port, host, () => {
        server = s
        status = { listening: true, port: s.address().port, error: '' }
        resolve()
      })
    })
  }

  function shut() {
    if (!server) return Promise.resolve()
    const s = server
    server = null
    status = { listening: false, port: 0, error: '' }
    hits.clear()
    return new Promise((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections?.()
    })
  }

  // Serialised: a toggle flicked twice quickly must not open two listeners on one port.
  const queue = (fn) => (chain = chain.then(fn, fn))

  return {
    sync: (enabled) => queue(() => (enabled ? (server ? undefined : open()) : shut())),
    status: () => ({ ...status }),
    close: () => queue(shut),
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/share.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add server/share.mjs test/share.test.mjs
git commit -m "Add the share port: one path, one method, a key, and nothing else"
```

---

### Task 5: Wire the share port into the server

**Files:**
- Modify: `server/api.mjs` (imports; new module-level service; `PUT /api/state`; new `GET /api/sharing`; exports `syncSharing`, `stopSharing`)
- Modify: `server/serve.mjs:61-63`
- Modify: `vite.config.js:5-10`
- Modify: `test/support/with-server.mjs`
- Test: `test/share.test.mjs` (append)

**Interfaces:**
- Consumes: `createShareService`, `SHARE_PATH` (Task 4); `buildSnapshot` (Task 3).
- Produces:
  - `GET /api/sharing → { listening, port, error, lanAddress, defaultName }`
  - `export async function syncSharing()` and `export function stopSharing()` from `server/api.mjs`
  - After a successful `PUT /api/state`, the share port is open iff `sharing.enabled` and `sharing.key` is set.

- [ ] **Step 1: Write the failing tests**

Append to `test/share.test.mjs`:

```js
// ── wired into the server ────────────────────────────────────────────────────

import { withServer } from './support/with-server.mjs'
import { withEnv } from './support/env.mjs'

const shareEnv = { BOT_CROSSING_SHARE_PORT: '0', BOT_CROSSING_SHARE_HOST: '127.0.0.1' }

test('turning sharing on in the colony file opens the port, and off closes it', async () => {
  await withEnv(shareEnv, () =>
    withServer(async ({ call, put }) => {
      let info = await (await call('/api/sharing')).json()
      assert.equal(info.listening, false)
      assert.equal(typeof info.defaultName, 'string')
      assert.ok('lanAddress' in info)

      await put({ sharing: { enabled: true, key: KEY, name: 'Mark' } })
      info = await (await call('/api/sharing')).json()
      assert.equal(info.listening, true)
      const res = await fetch(`http://127.0.0.1:${info.port}${SHARE_PATH}`, auth(KEY))
      assert.equal(res.status, 200)
      const snap = await res.json()
      assert.equal(snap.v, 1)
      assert.equal(snap.name, 'Mark')

      await put({ sharing: { enabled: false, key: KEY, name: 'Mark' } })
      assert.equal((await (await call('/api/sharing')).json()).listening, false)
    })
  )
})

test('rotating the key locks out the old one at once', async () => {
  await withEnv(shareEnv, () =>
    withServer(async ({ call, put }) => {
      await put({ sharing: { enabled: true, key: KEY, name: '' } })
      const { port } = await (await call('/api/sharing')).json()
      const fresh = '1'.repeat(32)
      await put({ sharing: { enabled: true, key: fresh, name: '' } })
      assert.equal((await fetch(`http://127.0.0.1:${port}${SHARE_PATH}`, auth(KEY))).status, 401)
      assert.equal((await fetch(`http://127.0.0.1:${port}${SHARE_PATH}`, auth(fresh))).status, 200)
    })
  )
})

test('the local API is not reachable through the share port', async () => {
  await withEnv(shareEnv, () =>
    withServer(async ({ call, put }) => {
      await put({ sharing: { enabled: true, key: KEY, name: '' } })
      const { port } = await (await call('/api/sharing')).json()
      for (const p of ['/api/state', '/api/threads', '/api/sharing', '/api/neighbors']) {
        assert.equal((await fetch(`http://127.0.0.1:${port}${p}`, auth(KEY))).status, 404, p)
      }
    })
  )
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/share.test.mjs`
Expected: the three new tests FAIL — `/api/sharing` answers 404 (`Unknown endpoint`), so `info.listening` is `undefined`.

- [ ] **Step 3: Close the share port when a test server ends**

Replace `test/support/with-server.mjs` with:

```js
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

/** `call` sets the `Origin` header the same-origin check expects, so a test never trips it by accident. */
export async function withServer(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-test-'))
  process.env.BOT_CROSSING_DATA = dir
  // Imported per-server so DATA_DIR is read fresh; the query string defeats the module cache.
  const api = await import(`../../server/api.mjs?${dir}`)
  const server = http.createServer((req, res) => api.apiMiddleware(req, res, null))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = (p, opts) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      headers: { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' },
      ...opts,
    })
  try {
    return await run({ call, dir, put: (b) => call('/api/state', { method: 'PUT', body: JSON.stringify(b) }) })
  } finally {
    server.close()
    // A test that turned sharing on would otherwise leave its port open for the rest of the run.
    await api.stopSharing?.()
    await fsp.rm(dir, { recursive: true, force: true })
  }
}
```

- [ ] **Step 4: Wire the service into the API**

In `server/api.mjs`, add to the imports at the top:

```js
import { createShareService } from './share.mjs'
import { buildSnapshot } from './share-snapshot.mjs'
```

Add this block directly after the `writeState` function (after line 128):

```js
// ── sharing ─────────────────────────────────────────────────────────────────────────

/**
 * Where friends reach this colony. Read once, at import, like DATA_DIR. `0` is a real value —
 * "any free port" — which is what the tests use, so it cannot be treated as unset.
 */
const SHARE_HOST = process.env.BOT_CROSSING_SHARE_HOST || '0.0.0.0'
const SHARE_PORT_RAW = process.env.BOT_CROSSING_SHARE_PORT
const SHARE_PORT = SHARE_PORT_RAW === undefined || SHARE_PORT_RAW === '' ? 5275 : Number(SHARE_PORT_RAW)

/** What friends see on the sign if the sharer never typed a name. */
function defaultName() {
  try {
    return os.userInfo().username || 'Neighbor'
  } catch {
    return 'Neighbor'
  }
}

/** The address a friend on the same Wi-Fi would type. The browser has no way to learn it. */
function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a && a.family === 'IPv4' && !a.internal && a.address) return a.address
    }
  }
  return ''
}

const sharing = createShareService({
  host: SHARE_HOST,
  port: SHARE_PORT,
  getKey: async () => {
    const s = (await readState()).sharing
    return s.enabled ? s.key : ''
  },
  snapshot: async () =>
    buildSnapshot({
      threads: await reconcileArchived(await scanThreads()),
      state: await readState(),
      name: defaultName(),
    }),
})

/** Open or close the share port to match the colony file. Called at boot and after every save. */
export async function syncSharing() {
  const s = (await readState()).sharing
  await sharing.sync(Boolean(s.enabled && s.key))
}

export function stopSharing() {
  return sharing.close()
}
```

(`reconcileArchived` and `scanThreads` are referenced inside an arrow function that only runs on a request, so their later declaration / import order does not matter.)

Replace the body of the `PUT /api/state` handler's `serialise` callback (currently lines 433–437) with:

```js
      return serialise(async () => {
        const current = await readState()
        if (base && current.updatedAt !== base) return send(res, 409, current)
        const saved = await writeState(body)
        // The page reads /api/sharing straight after a save that flipped the toggle, so the port
        // has to have opened (or failed to) before this answers.
        await syncSharing().catch(() => {})
        return send(res, 200, saved)
      })
```

Add a new route directly before the `if (url.pathname === '/api/open' …` line:

```js
    if (url.pathname === '/api/sharing' && req.method === 'GET') {
      return send(res, 200, { ...sharing.status(), lanAddress: lanAddress(), defaultName: defaultName() })
    }
```

- [ ] **Step 5: Open the port at boot from both entry points**

In `server/serve.mjs`, change the import line to:

```js
import { apiMiddleware, syncSharing } from './api.mjs'
```

and replace the `server.listen(…)` call at the bottom with:

```js
server.listen(PORT, HOST, () => {
  console.log(`Bot Crossing → http://${HOST}:${PORT}`)
  // A colony that was sharing when it last ran shares again, without waiting for the page.
  syncSharing().catch((err) => console.warn('bot-crossing: could not open the share port —', err?.message || err))
})
```

Replace `vite.config.js` with:

```js
import { defineConfig } from 'vite'
import { apiMiddleware, stopSharing, syncSharing } from './server/api.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
    // Sharing rides along with the dev server: open at start if the colony file says so, and
    // closed with it, so a restart does not find its own old port still bound.
    syncSharing().catch((err) => console.warn('bot-crossing: could not open the share port —', err?.message || err))
    server.httpServer?.once('close', () => stopSharing())
  },
})

export default defineConfig({
  plugins: [api()],
  // PORT lets a second copy run alongside the first without a flag on the command line.
  server: { port: Number(process.env.PORT) || 5274, strictPort: false },
  build: { target: 'esnext' },
})
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/share.test.mjs`
Expected: PASS (11 tests)

Run: `npm test`
Expected: only the 2 baseline failures.

- [ ] **Step 7: Check it by hand**

Run (PowerShell, from the repo root; uses a throwaway data dir so your real colony is untouched):

```powershell
$env:BOT_CROSSING_DATA = "$env:TEMP\bc-share-check"; $env:PORT = '5290'; $env:BOT_CROSSING_SHARE_PORT = '5291'
Start-Process -NoNewWindow node 'server/serve.mjs'
Start-Sleep 2
Invoke-RestMethod http://127.0.0.1:5290/api/sharing
```

Expected: `listening : False`, a `lanAddress`, and your username as `defaultName`. Stop the process afterwards (`Get-Process node | Where-Object { $_.CommandLine -match 'serve.mjs' } | Stop-Process`) and remove the env vars.

- [ ] **Step 8: Commit**

```bash
git add server/api.mjs server/serve.mjs vite.config.js test/support/with-server.mjs test/share.test.mjs
git commit -m "Open the share port from the colony file, and report it at /api/sharing"
```

---

### Task 6: Fetching friends

**Files:**
- Create: `server/neighbors.mjs`
- Modify: `server/api.mjs` (import, module-level fetcher, `GET /api/neighbors`)
- Test: `test/neighbors.test.mjs`

**Interfaces:**
- Consumes: `SHARE_PATH` (Task 4); `state.neighbors` (Task 2).
- Produces:
  - `validateSnapshot(json) → { ok: true, snapshot } | { ok: false, reason: 'needs-update' | 'malformed' }`
  - `createNeighborFetcher({ fetchImpl?, timeoutMs?, now? }) → { refresh(neighbors): Promise<NeighborResult[]> }`
  - `NeighborResult = { id: string, status: 'online'|'away'|'bad-key'|'needs-update'|'unreachable', lastSeenAt: number, snapshot: Snapshot|null }`
  - `GET /api/neighbors → { neighbors: NeighborResult[] }`
  - `Snapshot = { v: 1, name: string, generatedAt: number, projects: [{ name: string, cells: [[q,r]] }], threads: [{ id, project, harness, harnessName, running, unread, hasError, prState, lastActivityAt, createdAt, sizeBucket, isErrand }] }` — Part 2 consumes exactly this.

- [ ] **Step 1: Write the failing tests**

```js
// test/neighbors.test.mjs
/**
 * Everything a friend's machine sends is untrusted input to this one. These tests feed the
 * fetcher a fake friend that lies, stalls, and changes its mind.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { SHARE_PATH } from '../server/share.mjs'
import { createNeighborFetcher, validateSnapshot } from '../server/neighbors.mjs'
import { withServer } from './support/with-server.mjs'

const KEY = 'abcdefabcdefabcdefabcdefabcdefab'
const ID = 'n:0123456789abcdef'

const goodSnapshot = (extra = {}) => ({
  v: 1,
  name: 'Mark',
  generatedAt: 1,
  projects: [{ name: 'bot-crossing', cells: [[0, 0]] }],
  threads: [{
    id: ID, project: 'bot-crossing', harness: 'claude-code', harnessName: 'Claude Code',
    running: true, unread: false, hasError: false, prState: '', lastActivityAt: 60000,
    createdAt: 0, sizeBucket: 12, isErrand: false,
  }],
  ...extra,
})

/** A fake friend whose behaviour the test can change between requests. */
async function withFriend(run) {
  const friend = { reply: (req, res) => { res.writeHead(200); res.end(JSON.stringify(goodSnapshot())) } }
  const server = http.createServer((req, res) => friend.reply(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    return await run({ friend, url })
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

// ── validation ───────────────────────────────────────────────────────────────

test('a good snapshot passes through with unknown fields dropped', () => {
  const out = validateSnapshot(goodSnapshot({ extra: 'x', threads: [{ ...goodSnapshot().threads[0], title: 'leak?' }] }))
  assert.equal(out.ok, true)
  assert.equal('extra' in out.snapshot, false)
  assert.equal('title' in out.snapshot.threads[0], false)
})

test('another version asks for an update rather than guessing', () => {
  assert.deepEqual(validateSnapshot(goodSnapshot({ v: 2 })), { ok: false, reason: 'needs-update' })
})

test('oversized or shapeless snapshots are refused', () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `p${i}`, cells: [] }))
  assert.equal(validateSnapshot(goodSnapshot({ projects: many })).ok, false)
  assert.equal(validateSnapshot({ v: 1 }).ok, false)
  assert.equal(validateSnapshot('nope').ok, false)
  assert.equal(validateSnapshot(null).ok, false)
})

test('strings are trimmed and cleaned, cells must be whole-number pairs', () => {
  const out = validateSnapshot(goodSnapshot({
    name: 'Mark\u0007' + 'x'.repeat(200),
    projects: [{ name: 'bot-crossing', cells: [[0, 0], [1.5, 0], ['a', 1], [2, 2, 2], [3, 3]] }],
  }))
  assert.equal(out.snapshot.name.length, 40)
  assert.doesNotMatch(out.snapshot.name, /\u0007/)
  assert.deepEqual(out.snapshot.projects[0].cells, [[0, 0], [3, 3]])
})

test('threads with a bad id or an unknown project are dropped', () => {
  const t = goodSnapshot().threads[0]
  const out = validateSnapshot(goodSnapshot({ threads: [t, { ...t, id: 'claude-code:real' }, { ...t, id: 'n:fedcba9876543210', project: 'ghost' }] }))
  assert.equal(out.snapshot.threads.length, 1)
})

// ── fetching ─────────────────────────────────────────────────────────────────

test('a friend who answers is online', async () => {
  await withFriend(async ({ url, friend }) => {
    let auth = ''
    friend.reply = (req, res) => { auth = req.headers.authorization; res.end(JSON.stringify(goodSnapshot())) }
    const [r] = await createNeighborFetcher().refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'online')
    assert.equal(r.snapshot.name, 'Mark')
    assert.equal(auth, `Bearer ${KEY}`)
  })
})

test('a friend who goes quiet is away, and their last snapshot is kept', async () => {
  await withFriend(async ({ url, friend }) => {
    const fetcher = createNeighborFetcher({ timeoutMs: 200 })
    await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    friend.reply = () => {} // never answers
    const [r] = await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'away')
    assert.equal(r.snapshot.name, 'Mark')
    assert.ok(r.lastSeenAt > 0)
  })
})

test('a friend never reached is unreachable, with nothing to draw', async () => {
  const [r] = await createNeighborFetcher({ timeoutMs: 200 }).refresh([{ id: 'nb_1', url: 'http://127.0.0.1:9', key: KEY }])
  assert.deepEqual(r, { id: 'nb_1', status: 'unreachable', lastSeenAt: 0, snapshot: null })
})

test('a rotated key reads as bad-key', async () => {
  await withFriend(async ({ url, friend }) => {
    friend.reply = (req, res) => { res.writeHead(401); res.end('{}') }
    const [r] = await createNeighborFetcher().refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'bad-key')
  })
})

test('a friend on another version reads as needs-update', async () => {
  await withFriend(async ({ url, friend }) => {
    friend.reply = (req, res) => res.end(JSON.stringify(goodSnapshot({ v: 2 })))
    const [r] = await createNeighborFetcher().refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'needs-update')
  })
})

test('garbage from a friend is treated as them being away', async () => {
  await withFriend(async ({ url, friend }) => {
    const fetcher = createNeighborFetcher()
    await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    friend.reply = (req, res) => res.end('<html>not json</html>')
    const [r] = await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'away')
    assert.equal(r.snapshot.name, 'Mark')
  })
})

test('a snapshot older than a week is let go', async () => {
  await withFriend(async ({ url, friend }) => {
    let t = 1_000_000
    const fetcher = createNeighborFetcher({ timeoutMs: 200, now: () => t })
    await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    friend.reply = () => {}
    t += 8 * 24 * 3600 * 1000
    const [r] = await fetcher.refresh([{ id: 'nb_1', url, key: KEY }])
    assert.equal(r.status, 'away')
    assert.equal(r.snapshot, null)
  })
})

test('only http and https are fetched, and only the share path', async () => {
  let asked = []
  const fetchImpl = async (u) => { asked.push(String(u)); throw new Error('stop') }
  const fetcher = createNeighborFetcher({ fetchImpl })
  await fetcher.refresh([
    { id: 'a', url: 'file:///etc/passwd', key: KEY },
    { id: 'b', url: 'http://10.0.0.5:5275/anything?x=1', key: KEY },
  ])
  assert.deepEqual(asked, [`http://10.0.0.5:5275${SHARE_PATH}`])
})

test('/api/neighbors fetches every saved friend', async () => {
  await withFriend(async ({ url }) => {
    await withServer(async ({ call, put }) => {
      await put({ neighbors: [{ id: 'nb_1', url, key: KEY, slot: 0, addedAt: 1 }] })
      const body = await (await call('/api/neighbors')).json()
      assert.equal(body.neighbors.length, 1)
      assert.equal(body.neighbors[0].status, 'online')
      assert.equal(body.neighbors[0].snapshot.threads.length, 1)
    })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/neighbors.test.mjs`
Expected: FAIL — `Cannot find module '…/server/neighbors.mjs'`

- [ ] **Step 3: Write the module**

```js
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
    snapshot: { v: 1, name: str(json.name).slice(0, 40) || 'Neighbor', generatedAt: num(json.generatedAt), projects, threads },
  }
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
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${n.key}` }, signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      return keep('away')
    }
    if (res.status === 401) return keep('bad-key')
    if (!res.ok) return keep('away')

    let json
    try {
      const text = await res.text()
      if (text.length > MAX_BODY) return keep('away')
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
```

Note `new URL(SHARE_PATH, n.url)` resolves an absolute path against the friend's URL, so any path or query a link carried is replaced by the share path — that is what the last fetching test checks.

- [ ] **Step 4: Add the route**

In `server/api.mjs`, add to the imports:

```js
import { createNeighborFetcher } from './neighbors.mjs'
```

Add directly under the `stopSharing` function from Task 5:

```js
/** Friends' last good snapshots live here for as long as this server does — never on disk. */
const neighborFetcher = createNeighborFetcher()
```

Add a route directly after the `/api/sharing` route:

```js
    if (url.pathname === '/api/neighbors' && req.method === 'GET') {
      const { neighbors } = await readState()
      return send(res, 200, { neighbors: await neighborFetcher.refresh(neighbors) })
    }
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/neighbors.test.mjs`
Expected: PASS (14 tests)

Run: `npm test`
Expected: only the 2 baseline failures.

- [ ] **Step 6: Commit**

```bash
git add server/neighbors.mjs server/api.mjs test/neighbors.test.mjs
git commit -m "Fetch friends' colonies server side, validated, with a last-good copy"
```

---

### Task 7: Say so in the docs

**Files:**
- Modify: `DECISIONS.md` (append two sections)
- Modify: `README.md:9-11` (the "nothing is uploaded" promise) and add a section after "## Keys"

- [ ] **Step 1: Append to DECISIONS.md**

```markdown
## What a friend sees is an allowlist

`server/share-snapshot.mjs` builds every shared thread field by field from a fixed list:
`project`, `harness`, `harnessName`, the four status flags, the two timestamps floored to the
minute, a size bucket, and a salted hash for an id. Nothing is deleted from a thread to make it
safe; a field is either named there or it does not leave the machine.

A denylist would be shorter today and wrong the first time an adapter adds a field — the new
field would be published the day it landed, and nobody would notice, because nothing breaks.
A PR that adds a field to the share list is a PR about privacy and gets read as one.

## The share port is the only thing that listens to other machines

The API binds to loopback and refuses any page it did not serve. Sharing does not loosen that:
it opens a *second* `http.Server`, with its own handler, that answers `GET /share/v1/colony`
with a Bearer key and nothing else. It exists only while sharing is on.

It is deliberately not the API middleware behind a different guard. The things a stranger must
never reach — opening a thread, starting a session, writing the colony file — are not routes
on that server at all, so there is no check to get wrong.
```

- [ ] **Step 2: Update the promise at the top of README.md**

Replace README lines 9–11:

```markdown
It reads the harness's own files, on your own machine. Nothing is uploaded, there is no
account, and **it never writes to a harness at all** — `data/colony.json`, where the map lives,
is the only file it writes anywhere.
```

with:

```markdown
It reads the harness's own files, on your own machine. Nothing is uploaded, there is no
account, and **it never writes to a harness at all** — `data/colony.json`, where the map lives,
is the only file it writes anywhere. The one thing that ever leaves the machine is opt-in:
[sharing with neighbors](#neighbors) on the same Wi-Fi, which sends repo names and what the bots
are doing, never a title, a prompt or a path.
```

- [ ] **Step 3: Add a Neighbors section to README.md**

Insert directly before the line `## Planets and light`:

```markdown
## Neighbors

Friends on the same Wi-Fi can see each other's colonies as neighbouring settlements.

- **Share yours:** Settings → Neighbors → *Share my colony*. You get a link like
  `http://192.168.1.42:5275/#k=…` — give it to whoever you like. *New link* makes a fresh one and
  the old one stops working at once.
- **Add a friend's:** paste their link into *Add neighbor*. Up to six; each gets their own side of
  your colony and keeps it.

A friend sees your repo names, how big each building is, and what each bot is doing — working,
waiting, stuck, asleep. Never a thread title, a prompt, a folder path, a branch or a model.
Archived threads and hidden repos stay off their map too.

Sharing opens a second, read-only port (5275; `BOT_CROSSING_SHARE_PORT` changes it) that answers
one request and nothing else — see [DECISIONS.md](DECISIONS.md). The first time it opens, Windows
asks whether Node may use the network: allow it on private networks, or friends cannot reach you.
```

- [ ] **Step 4: Commit**

```bash
git add DECISIONS.md README.md
git commit -m "Document what sharing sends and why the share port is separate"
```

---

## Self-review notes

- Spec §1 (share port, toggle storage, `/api/sharing`, listener rules, rate limit, EADDRINUSE, snapshot shape and rules) → Tasks 2–5. The browser-side toggle, key generation and link display are Part 2.
- Spec §2 storage + merge → Task 2; fetch, statuses, last-good cache, 7-day drop, validation → Task 6. The page calling `/api/neighbors` from `poll()` is Part 2.
- Spec §4 failure rows that are server-side (offline, bad key, malformed, needs-update, port taken) → Tasks 4 and 6. The firewall hint is UI, Part 2.
- Spec §5 tests: redaction → Task 3; listener → Tasks 4–5; fetch → Task 6; state → Task 2.
