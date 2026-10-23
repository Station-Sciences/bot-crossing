import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVE, JumpRun, busiestOrder, crewOrder, inScope, needsYouOrder, nextInRing } from '../src/game/jumps.js'

const crew = [
  { id: 'a1', project: 'alpha', status: 'working', lastActivityAt: 50 },
  { id: 'a2', project: 'alpha', status: 'waiting', lastActivityAt: 10 },
  { id: 'b1', project: 'beta', status: 'blocked', lastActivityAt: 5 },
  { id: 'b2', project: 'beta', status: 'working', lastActivityAt: 90 },
  { id: 'c1', project: 'gamma', status: 'approval', lastActivityAt: 20 },
]
const order = ['alpha', 'beta', 'gamma']
const ids = (list) => list.map((c) => c.id)

test('plain stays inside the open zone, shift is strictly outside it', () => {
  assert.deepEqual(ids(inScope(crew, 'beta')), ['b1', 'b2'])
  assert.deepEqual(ids(inScope(crew, 'beta', { outside: true })), ['a1', 'a2', 'c1'])
  assert.equal(inScope(crew, null, { outside: true }).length, crew.length)
})

test('shift+J tours the zones: first crew of the next zone, wrapping', () => {
  const all = crewOrder(crew, order)
  const step = (selectedId, project) => {
    const pool = new Set(ids(inScope(all, project, { outside: true })))
    return nextInRing(all, (c) => pool.has(c.id), selectedId)
  }
  assert.equal(step('a2', 'alpha'), 'b1')
  assert.equal(step('b1', 'beta'), 'c1')
  assert.equal(step('c1', 'gamma'), 'a1')
})

test('plain J walks the open zone only', () => {
  const all = crewOrder(crew, order)
  const pool = new Set(ids(inScope(all, 'alpha')))
  const step = (selectedId) => nextInRing(all, (c) => pool.has(c.id) && c.id !== selectedId, selectedId)
  assert.equal(step('a1'), 'a2')
  assert.equal(step('a2'), 'a1')
  assert.equal(step(null), 'a1')
})

test('busiest puts errored crew first, then most recent activity', () => {
  assert.deepEqual(ids(busiestOrder(crew)), ['b1', 'b2', 'a1', 'c1', 'a2'])
})

test('needs-you is errors, approvals, replies — longest waiting first within each', () => {
  const extra = [...crew, { id: 'a3', project: 'alpha', status: 'waiting', lastActivityAt: 2 }]
  const needs = extra.filter((c) => ['blocked', 'approval', 'waiting'].includes(c.status))
  assert.deepEqual(ids(needsYouOrder(needs)), ['b1', 'c1', 'a3', 'a2'])
})

test('a run walks its first-press snapshot even as the ranking and zone change', () => {
  const run = new JumpRun()
  let ranking = ['b2', 'a1', 'c1']
  let selected = null
  const press = () => (selected = run.next('busiest:true', selected, () => ranking, () => true))
  assert.equal(press(), 'b2')
  ranking = ['c1', 'b2', 'a1'] // activity moved; a re-rank would bounce back to c1 and skip a1
  assert.equal(press(), 'a1')
  assert.equal(press(), 'c1')
  assert.equal(press(), 'b2')
})

test('a run restarts when you pick someone else or press a different key', () => {
  const run = new JumpRun()
  const rank = () => ['x', 'y', 'z']
  assert.equal(run.next('busiest:false', null, rank, () => true), 'x')
  assert.equal(run.next('busiest:false', 'x', rank, () => true), 'y')
  // Clicked z by hand: next press starts at the top, not after y.
  assert.equal(run.next('busiest:false', 'z', rank, () => true), 'x')
  // Already on the top bot: the first press moves on rather than doing nothing.
  assert.equal(run.next('needs:false', 'x', rank, () => true), 'y')
})

test('a run skips bots that left or stopped qualifying, and stays put when alone', () => {
  const run = new JumpRun()
  const rank = () => ['x', 'y', 'z']
  let alive = new Set(['x', 'y', 'z'])
  assert.equal(run.next('needs:false', null, rank, (id) => alive.has(id)), 'x')
  alive.delete('y') // answered
  assert.equal(run.next('needs:false', 'x', rank, (id) => alive.has(id)), 'z')
  alive = new Set(['z'])
  assert.equal(run.next('needs:false', 'z', rank, (id) => alive.has(id)), 'z')
  alive = new Set()
  assert.equal(run.next('needs:false', 'z', rank, (id) => alive.has(id)), null)
})

test('busiest only reaches bots with something going on', () => {
  for (const s of ['blocked', 'approval', 'waiting', 'working']) assert.ok(ACTIVE.includes(s), s)
  for (const s of ['idle', 'sleeping', 'celebrating', 'leaving']) assert.ok(!ACTIVE.includes(s), s)
})
