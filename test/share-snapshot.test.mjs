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

test('a project shares only its last folder name, never a path', () => {
  // What disambiguateProjects makes of two repos called foo, and of a path with nothing to trim.
  const threads = [
    secretThread(1, { project: '1/foo' }),
    secretThread(2, { project: '2/foo' }),
    secretThread(3, { project: 'c:/x/api' }),
    secretThread(4, { project: 'C:\\Users\\x\\web' }),
  ]
  const plots = { '1/foo': [[0, 0]], '2/foo': [[1, 1]], 'c:/x/api': [[2, 2]], 'C:\\Users\\x\\web': [[3, 3]] }
  const snap = buildSnapshot({ threads, state: baseState({ plots }), now: NOW })
  const names = snap.projects.map((p) => p.name)
  for (const n of [...names, ...snap.threads.map((t) => t.project)]) {
    assert.doesNotMatch(n, /[\\/]|^[A-Za-z]:/, n)
  }
  assert.deepEqual(snap.projects, [
    { name: 'foo', cells: [[0, 0]] },
    { name: 'foo (2)', cells: [[1, 1]] },
    { name: 'api', cells: [[2, 2]] },
    { name: 'web', cells: [[3, 3]] },
  ])
  assert.deepEqual(snap.threads.map((t) => t.project), ['foo', 'foo (2)', 'api', 'web'])
})

// ── war ──────────────────────────────────────────────────────────────────────

const WAR = { id: 'war_k_1', target: 'a'.repeat(16), seed: 9, startedAt: NOW, attackers: 4, defenders: 5, targetNeighborId: 'nb_SECRET' }

test('warReady mirrors the toggle, and there is no battle at peace', () => {
  const off = buildSnapshot({ threads: [], state: baseState(), now: NOW })
  assert.equal(off.warReady, false)
  assert.equal(off.battle, null)
  const on = buildSnapshot({ threads: [], state: baseState({ war: { enabled: true, battle: null } }), now: NOW })
  assert.equal(on.warReady, true)
})

test('a battle is announced while live and gone after it has lingered, and never names its target', () => {
  const state = baseState({ war: { enabled: true, battle: WAR } })
  const live = buildSnapshot({ threads: [], state, now: NOW + 1000 })
  assert.deepEqual(live.battle, { id: WAR.id, target: WAR.target, seed: 9, startedAt: NOW, attackers: 4, defenders: 5 })
  assert.doesNotMatch(JSON.stringify(live), /SECRET|targetNeighborId/)
  const later = buildSnapshot({ threads: [], state, now: NOW + 10 * 60_000 })
  assert.equal(later.battle, null)
})
