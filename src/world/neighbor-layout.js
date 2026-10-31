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
