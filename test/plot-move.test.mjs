/**
 * The rules a hand-dragged zone obeys before it is allowed to land. Pure by design — see
 * plot-move.js for why they live apart from the meshes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SHIP_CELL, componentsOf, isConnected, moveIsValid, planMove, translateCells } from '../src/world/plot-move.js'

const layout = (zones) => new Map(Object.entries(zones))

// ── translation ───────────────────────────────────────────────────────────────

test('cells translate as one body, root first', () => {
  const moved = translateCells([{ q: 2, r: 3 }, { q: 3, r: 3 }, { q: 2, r: 4 }], 1, -2)
  assert.deepEqual(moved, [{ q: 3, r: 1 }, { q: 4, r: 1 }, { q: 3, r: 2 }])
})

test('translation never reorders — the root is whichever cell was first', () => {
  const cells = [{ q: 5, r: -1 }, { q: 4, r: 0 }]
  assert.deepEqual(translateCells(cells, -5, 1)[0], { q: 0, r: 0 })
  // And the input is untouched: the drag re-translates from the lifted footprint every move.
  assert.deepEqual(cells[0], { q: 5, r: -1 })
})

// ── validity ──────────────────────────────────────────────────────────────────

test('a move onto another zone\'s cell is refused', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }] })
  assert.equal(moveIsValid(zones, 'a', 1, 0), false)
})

test('a zone never collides with itself — the identity move is valid', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }, { q: 1, r: 0 }] })
  assert.equal(moveIsValid(zones, 'a', 0, 0), true)
})

test('the ship\'s cell is refused even when nothing else claims it', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }, { q: 0, r: 1 }] })
  assert.equal(moveIsValid(zones, 'a', SHIP_CELL.q, SHIP_CELL.r - 1), false)
})

test('a move that splits the colony into islands is refused', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }] })
  // (6, 5) is well inside the allocator's pool but touches nothing.
  assert.equal(moveIsValid(zones, 'b', 5, 5), false)
})

test('a move to a free neighbouring cell is accepted', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }] })
  assert.equal(moveIsValid(zones, 'b', -1, 1), true)
})

test('a move past the allocator\'s pool is refused — it would lose its ground next pass', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }] })
  assert.equal(moveIsValid(zones, 'a', 12, 0), false)
  assert.equal(moveIsValid(zones, 'a', 11, 0), true)
})

// ── connectivity ──────────────────────────────────────────────────────────────

test('the ship bridges two zones without counting as one', () => {
  // Both cells neighbour the ship and nothing else: whole through it, split without it.
  const bridged = layout({ a: [{ q: -2, r: 0 }], b: [{ q: -2, r: 2 }] })
  assert.equal(isConnected(bridged), true)
})

// ── carrying a zone out from between its neighbours ───────────────────────────

/** Names of each group, sorted, so a component split is easy to assert on. */
const groups = (l) => componentsOf(l).map((g) => [...g].sort().join('+')).sort()

test('a colony that has not fragmented is one group', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }], c: [{ q: 2, r: 0 }] })
  assert.deepEqual(groups(zones), ['a+b+c'])
})

test('components split where the cells stop touching', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 6, r: 0 }], c: [{ q: 7, r: 0 }] })
  assert.deepEqual(groups(zones), ['a', 'b+c'])
})

test('carrying the middle zone away no longer refuses — the stranded one follows', () => {
  // a — b — c in a row. b swings round to a's other side, which cuts c loose: its only
  // neighbour was b. Lifting b out of the middle like this used to be refused outright.
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }], c: [{ q: 2, r: 0 }] })
  assert.equal(moveIsValid(zones, 'b', -1, 1), false, 'the old rule still says it splits the colony')

  const after = planMove(zones, 'b', -1, 1)
  assert.ok(after, 'but the drop is allowed now')
  assert.deepEqual(after.get('b'), [{ q: 0, r: 1 }], 'b lands exactly where it was dropped')
  assert.equal(isConnected(after), true, 'and the colony is whole again')
})

test('a stranded group keeps its own shape and spacing', () => {
  // c and d sit together past b; swinging b round to a's far side strands them as one body.
  const zones = layout({
    a: [{ q: 0, r: 0 }],
    b: [{ q: 1, r: 0 }],
    c: [{ q: 2, r: 0 }],
    d: [{ q: 3, r: 0 }],
  })
  const after = planMove(zones, 'b', -2, 1)
  assert.ok(after)
  const [c] = after.get('c')
  const [d] = after.get('d')
  assert.equal(hexStep(c, d), 1, 'c and d are still neighbours, carried as one piece')
  assert.equal(isConnected(after), true)
})

test('the zone you dropped is the one that does not move', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }], c: [{ q: 2, r: 0 }] })
  const after = planMove(zones, 'b', -1, 1)
  assert.ok(after)
  assert.deepEqual(after.get('b'), [{ q: 0, r: 1 }], 'exactly where the cursor left it')
  assert.deepEqual(after.get('a'), [{ q: 0, r: 0 }], 'what it landed against did not budge')
})

test('a drop onto an occupied cell is still refused', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }] })
  assert.equal(planMove(zones, 'b', -1, 0), null)
})

test('a drop past the pool is still refused', () => {
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }] })
  assert.equal(planMove(zones, 'b', 40, 0), null)
})

test('a move that keeps contact asks nobody else to move', () => {
  // c swings from the end of the row round to b's other side; the chain never breaks.
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }], c: [{ q: 2, r: 0 }] })
  const after = planMove(zones, 'c', -1, 1)
  assert.ok(after)
  assert.deepEqual(after.get('c'), [{ q: 1, r: 1 }])
  assert.deepEqual(after.get('a'), [{ q: 0, r: 0 }], 'nobody else was asked to move')
  assert.deepEqual(after.get('b'), [{ q: 1, r: 0 }])
})

test('a drop into open ground is refused rather than dragging the colony over to meet it', () => {
  // Without this the move is still "legal" — the rest of the map would simply slide across to
  // reach it, so nudging one zone into the sea rearranges everything else to chase it.
  const zones = layout({ a: [{ q: 0, r: 0 }], b: [{ q: 1, r: 0 }], c: [{ q: 2, r: 0 }] })
  assert.equal(planMove(zones, 'b', 0, 6), null)
  // A lone zone has nothing to touch, so the rule does not apply to it.
  const only = layout({ a: [{ q: 0, r: 0 }] })
  assert.ok(planMove(only, 'a', 0, 3))
})

function hexStep(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2
}
