/**
 * Moving a zone by hand: the rules a drop has to obey, plus the lattice facts they rest on.
 *
 * Split out of plots.js for the same reason merge-state.js exists: getting a drop rule wrong
 * quietly corrupts somebody's colony — a zone parked on top of another, or an island the
 * allocator responds to by re-laying the whole map from scratch — so the rules are pure and
 * run under bare node, where plots.js cannot follow (its texture pipeline needs a document).
 */

export const HEX_DIRS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
]

/** The lattice cell the ship owns. Nothing else may be placed there. */
export const SHIP_CELL = { q: -2, r: 1 }

export const ORIGIN = { q: 0, r: 0 }

/**
 * How many rings out the allocator's cell pool reaches. A cell past this is one the
 * allocator does not know exists: a zone dropped there would pass every visible check, then
 * lose its ground on the next roster pass when `allocateCells` cannot find its root in the
 * pool and re-seeds it in the middle — the exact jump the drag is for preventing.
 */
export const POOL_RINGS = 12

export const cellKey = (q, r) => `${q},${r}`

/** Hex distance in axial coordinates: the cube distance, halved. */
export function hexDistance(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2
}

/**
 * Is the colony one landmass?
 *
 * Every zone is a contiguous blob of its own, but nothing has ever guaranteed the *union* of
 * them is — that held only because zones seed outward in spiral order from the middle, which
 * happens to leave no gaps when everybody who was ever placed is still on the map.
 *
 * Take repos away and the guarantee goes with it. The survivors keep the cells they held in the
 * bigger layout, which is the whole point of the stickiness, but if the zones between them have
 * gone those cells are now islands floating in the sea. That is what folding away dormant repos
 * does the first time it runs.
 *
 * The ship's cell counts as walkable here even though nobody may claim it: a colony that
 * happens to wrap around the ship is not two colonies.
 */
export function isConnected(out) {
  const cells = new Map()
  for (const [, list] of out) for (const c of list) cells.set(cellKey(c.q, c.r), c)
  if (cells.size < 2) return true
  const ship = cellKey(SHIP_CELL.q, SHIP_CELL.r)
  const passable = new Set([...cells.keys(), ship])
  const [start] = cells.keys()
  const seen = new Set([start])
  const queue = [cells.get(start)]
  while (queue.length) {
    const c = queue.pop()
    for (const [dq, dr] of HEX_DIRS) {
      const n = { q: c.q + dq, r: c.r + dr }
      const k = cellKey(n.q, n.r)
      if (!passable.has(k) || seen.has(k)) continue
      seen.add(k)
      queue.push(n)
    }
  }
  // The ship is a stepping stone, not a member: it does not have to be reached for the colony
  // to be whole, and it does not count toward what has to be.
  seen.delete(ship)
  return seen.size === cells.size
}

/** Slide a zone whole. Order is identity here: cells[0] stays the root wherever it lands. */
export function translateCells(cells, dq, dr) {
  return cells.map((c) => ({ q: c.q + dq, r: c.r + dr }))
}

/**
 * May this zone move by (dq, dr)?
 *
 * Checked against the zones actually on the map rather than everything layout memory
 * remembers: a hidden repo's old ground is fair game, exactly as it is when a visible
 * neighbour grows into it. The identity move is valid by construction — a zone never
 * collides with itself, because its own cells are not in the occupied set.
 *
 * @param layout Map of name → cells for every zone on the map, the moving one included.
 */
export function moveIsValid(layout, name, dq, dr) {
  const cells = layout.get(name)
  if (!cells?.length) return false
  const moved = translateCells(cells, dq, dr)

  const occupied = new Set()
  for (const [id, list] of layout) {
    if (id === name) continue
    for (const c of list) occupied.add(cellKey(c.q, c.r))
  }
  const ship = cellKey(SHIP_CELL.q, SHIP_CELL.r)
  for (const c of moved) {
    const k = cellKey(c.q, c.r)
    if (k === ship || occupied.has(k)) return false
    if (hexDistance(c, ORIGIN) >= POOL_RINGS) return false
  }

  // The allocator throws the whole layout memory away when the colony fragments, so a drop
  // that splits it would take every other zone's ground with it. Refused here, where it is
  // one red ghost, rather than there, where it is a full re-layout.
  const after = new Map(layout)
  after.set(name, moved)
  return isConnected(after)
}
