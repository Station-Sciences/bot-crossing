/**
 * The rules a hand-dragged zone obeys before it is allowed to land. Pure by design — see
 * plot-move.js for why they live apart from the meshes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SHIP_CELL, isConnected, moveIsValid, translateCells } from '../src/world/plot-move.js'

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
