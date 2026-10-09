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
