import test from 'node:test'
import assert from 'node:assert/strict'
import { archivedInProject, restorableArchives, threadIds, unarchive, withLocalArchive } from '../src/game/archive.js'

// Re-keyed: archived under its desktop id, now known by its CLI session id.
const rekeyed = {
  id: 'cli-1',
  project: 'alpha',
  title: 'Re-keyed',
  archived: true,
  archivedInHarness: false,
  ref: { desktopSessionId: 'desk-1', desktopSessionIds: ['desk-0', 'desk-1'], cliSessionId: 'cli-1', cwd: '/x' },
}
const plain = { id: 'p-1', project: 'alpha', title: 'Plain', archived: true, archivedInHarness: false }
const harness = { id: 'h-1', project: 'alpha', title: 'Harness', archived: true, archivedInHarness: true }
const elsewhere = { id: 'e-1', project: 'beta', title: 'Elsewhere', archived: true, archivedInHarness: false }
const live = { id: 'l-1', project: 'alpha', title: 'Live', archived: false }

const state = {
  archived: ['desk-0', 'p-1', 'h-1', 'e-1', 'keep'],
  archivedAt: { 'desk-0': 100, 'p-1': 300, 'h-1': 200, 'e-1': 50, keep: 1 },
}

test('a thread answers to its current id and every id in its ref', () => {
  assert.deepEqual(threadIds(rekeyed), ['cli-1', 'desk-1', 'desk-0', 'desk-1', 'cli-1', '/x'])
  assert.deepEqual(threadIds(plain), ['p-1'])
  // A stub from the server carries only the ids that matched the list.
  assert.deepEqual(threadIds({ id: 'cli-9', archivedAs: ['desk-9'] }), ['cli-9', 'desk-9'])
})

test('a stub is restored by the ids the server matched it on', () => {
  const stubbed = { id: 'cli-9', project: 'alpha', archived: true, archivedInHarness: false, archivedAs: ['desk-9'] }
  const next = unarchive({ archived: ['desk-9', 'keep'], archivedAt: { 'desk-9': 1 } }, stubbed)
  assert.deepEqual(next.archived, ['keep'])
  assert.equal(withLocalArchive(stubbed, new Set(next.archived)).archived, false)
})

test('un-archiving removes whichever of its ids the list holds, and only those', () => {
  const next = unarchive(state, rekeyed)
  assert.deepEqual(next.archived, ['p-1', 'h-1', 'e-1', 'keep'])
  assert.equal(next.archivedAt['desk-0'], undefined)
  assert.equal(next.archivedAt.keep, 1)
  // The input is left alone.
  assert.ok(state.archived.includes('desk-0'))
})

test("a restored thread is back on the map before the next scan clears the server's flag", () => {
  const next = new Set(unarchive(state, plain).archived)
  assert.equal(withLocalArchive(plain, next).archived, false)
  // Still on the list: stays archived.
  assert.equal(withLocalArchive(plain, new Set(state.archived)).archived, true)
  // Archived in the harness: the colony cannot take that back.
  assert.equal(withLocalArchive(harness, new Set()).archived, true)
  // A scan made with an empty list carries no `archivedInHarness`; its flag is the harness's.
  assert.equal(withLocalArchive({ id: 'x', archived: true }, new Set()).archived, true)
})

test("a zone lists only its own restorable archives, newest first, matched by any id", () => {
  const list = archivedInProject([rekeyed, plain, harness, elsewhere, live], state, 'alpha')
  assert.deepEqual(
    list.map((t) => [t.id, t.archivedAt]),
    [
      ['p-1', 300],
      ['cli-1', 100],
    ]
  )
})

test('archives in repos that left the map are listed with their repo, others are not', () => {
  const onMap = new Set(['alpha'])
  const list = restorableArchives([rekeyed, plain, harness, elsewhere, live], state, (p) => !onMap.has(p))
  assert.deepEqual(
    list.map((t) => [t.id, t.project]),
    [['e-1', 'beta']]
  )
})
