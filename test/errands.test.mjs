/**
 * Errands: a subagent becomes an astronaut like any other.
 *
 * The failure mode worth a test is an id collision. The colony keys its archive list and its
 * saved layout on a thread id, so two threads sharing one is not a cosmetic bug — it draws one
 * bot twice and archives something that is not a session.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { errandId, isErrandId, withErrands } from '../src/game/errands.js'

const parent = (id, subagents) => ({
  id,
  title: 'parent',
  project: 'repo',
  projectPath: '/tmp/repo',
  lastActivityAt: 1000,
  running: false,
  unread: true,
  canOpen: true,
  ref: { sessionId: 'abc' },
  subagents,
})

test('an errand becomes a thread in its parent’s zone', () => {
  const [, errand] = withErrands([parent('p1', [{ id: 'a', task: 'check the logs', lastActivityAt: 2000 }])])
  assert.equal(errand.project, 'repo', 'lands on the parent’s plot')
  assert.equal(errand.projectPath, '/tmp/repo')
  assert.equal(errand.title, 'check the logs')
  assert.equal(errand.lastActivityAt, 2000)
  assert.equal(errand.parentId, 'p1')
})

test('an errand is working, and never the one asking for you', () => {
  const [, errand] = withErrands([parent('p1', [{ id: 'a', task: 't' }])])
  assert.equal(errand.running, true)
  assert.equal(errand.unread, false, 'the parent carries the ?, not the errand — or it counts twice')
  assert.equal(errand.canOpen, false, 'a subagent has no session of its own to resume')
})

test('ids are prefixed by parent, so two parents can each have an errand "a"', () => {
  const out = withErrands([parent('p1', [{ id: 'a', task: 't' }]), parent('p2', [{ id: 'a', task: 't' }])])
  const ids = out.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length, 'no id collides')
  assert.equal(ids[1], errandId('p1', 'a'))
  assert.ok(isErrandId(ids[1]) && !isErrandId('p1'))
})

test('a second pass does not fan the same errand out again', () => {
  const once = withErrands([parent('p1', [{ id: 'a', task: 't' }])])
  assert.equal(withErrands(once).length, once.length, 'the copy carries no subagents of its own')
})

test('a thread with no errands is passed through untouched', () => {
  const t = parent('p1', undefined)
  assert.deepEqual(withErrands([t]), [t])
  assert.deepEqual(withErrands([]), [])
})

test('a subagent with no id is skipped rather than making a thread keyed on undefined', () => {
  const out = withErrands([parent('p1', [{ task: 'no id' }, { id: 'b', task: 'fine' }])])
  assert.equal(out.length, 2)
  assert.equal(out[1].id, errandId('p1', 'b'))
})
