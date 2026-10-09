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
