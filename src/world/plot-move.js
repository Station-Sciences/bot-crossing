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
export function fits(layout, name, dq, dr) {
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
  return true
}

/**
 * Does this move land somewhere legal *and* leave the colony in one piece on its own?
 *
 * Kept as its own predicate because it is the question `isConnected` was written for, and the
 * tests below pin it. The drag no longer asks it: a move that splits the colony is now allowed
 * and the pieces are slid back together — see `planMove`.
 */
export function moveIsValid(layout, name, dq, dr) {
  if (!fits(layout, name, dq, dr)) return false
  const after = new Map(layout)
  after.set(name, translateCells(layout.get(name), dq, dr))
  return isConnected(after)
}

/**
 * The zones that are still touching each other, as groups of names.
 *
 * Same walk as `isConnected`, but it keeps the pieces instead of counting them. A colony that
 * has not fragmented comes back as one group.
 */
export function componentsOf(layout) {
  const owner = new Map()
  for (const [name, list] of layout) for (const c of list) owner.set(cellKey(c.q, c.r), name)
  const ship = cellKey(SHIP_CELL.q, SHIP_CELL.r)

  const groups = []
  const placed = new Set()
  for (const [name] of layout) {
    if (placed.has(name)) continue
    const group = new Set([name])
    placed.add(name)
    // Walk cells, not zones: two zones are in the same group when their cells touch, and the
    // ship is a stepping stone between them the same way it is for `isConnected`.
    const seen = new Set()
    const queue = [...(layout.get(name) || [])]
    for (const c of queue) seen.add(cellKey(c.q, c.r))
    while (queue.length) {
      const c = queue.pop()
      for (const [dq, dr] of HEX_DIRS) {
        const n = { q: c.q + dq, r: c.r + dr }
        const k = cellKey(n.q, n.r)
        if (seen.has(k)) continue
        const who = owner.get(k)
        if (!who && k !== ship) continue
        seen.add(k)
        if (who && !placed.has(who)) {
          placed.add(who)
          group.add(who)
        }
        queue.push(n)
      }
    }
    groups.push(group)
  }
  return groups
}

/** Does this zone share an edge with any other zone, or with the ship it may step across? */
function touchesOthers(layout, name) {
  const others = new Set()
  for (const [id, list] of layout) {
    if (id === name) continue
    for (const c of list) others.add(cellKey(c.q, c.r))
  }
  others.add(cellKey(SHIP_CELL.q, SHIP_CELL.r))
  for (const c of layout.get(name)) {
    for (const [dq, dr] of HEX_DIRS) if (others.has(cellKey(c.q + dq, c.r + dr))) return true
  }
  return false
}

/** Offsets ordered by how far they move something, nearest first. Ring 0 — staying put — first. */
function offsetsByDistance(rings) {
  const out = [{ dq: 0, dr: 0 }]
  for (let ring = 1; ring <= rings; ring++) {
    let q = -ring
    let r = ring
    for (const [dq, dr] of HEX_DIRS) {
      for (let step = 0; step < ring; step++) {
        out.push({ dq: q, dr: r })
        q += dq
        r += dr
      }
    }
  }
  return out
}

const OFFSETS = offsetsByDistance(POOL_RINGS * 2)

/**
 * Move a zone, and bring back whatever that stranded.
 *
 * Dragging a zone out from between its neighbours used to be refused, because the allocator
 * throws the whole layout away when the colony fragments — so a drop that split it would take
 * every other zone's ground with it. Refusing was the safe answer and the wrong one: the zone
 * you are holding is the one you have an opinion about, and the colony should rearrange itself
 * around that rather than telling you no.
 *
 * So the drop stands, and any group it cut loose is slid back into contact. Each stranded group
 * moves as a rigid body — its zones keep their shape and their arrangement relative to each
 * other, so a colony you have already laid out by hand is not re-shuffled behind your back — and
 * it takes the shortest offset that touches what is already placed. Largest group first, because
 * a big blob has fewer places it fits and should choose before the small ones fill them.
 *
 * Adjacency is enough to prove the result is whole: every group is internally connected to begin
 * with, so a group touching the placed set joins it entire.
 *
 * @returns the new layout, or null if a stranded group has nowhere legal to go.
 */
export function planMove(layout, name, dq, dr) {
  if (!fits(layout, name, dq, dr)) return null

  const after = new Map(layout)
  after.set(name, translateCells(layout.get(name), dq, dr))

  // The zone has to land against something. Without this a drop in open ground is still
  // "legal" — the colony would simply slide over to meet it, and dragging one zone two cells
  // into the sea would rearrange eight others to chase it. Requiring contact keeps the drop
  // local: whatever the move cuts off gets slid back, and nothing else is disturbed.
  if (layout.size > 1 && !touchesOthers(after, name)) return null

  const groups = componentsOf(after)
  if (groups.length < 2) return after

  // The zone under the cursor anchors the colony: it stays exactly where it was dropped, and
  // everything cut loose comes to it.
  const anchor = groups.find((g) => g.has(name)) || groups[0]
  // ...which only makes sense while the zone is still part of the main body. Dropped somewhere
  // that leaves it holding a corner of the map on its own — hard against the ship, say — the
  // "stranded" piece would be the entire rest of the colony, and honouring the drop would drag
  // every other zone across to reach it. That is a refusal, not a rearrangement.
  const biggest = groups.reduce((a, g) => (g.size > a.size ? g : a), groups[0])
  if (anchor.size < biggest.size) return null

  const stranded = groups.filter((g) => g !== anchor).sort((a, b) => b.size - a.size)

  const ship = cellKey(SHIP_CELL.q, SHIP_CELL.r)
  const placed = new Set()
  for (const zone of anchor) for (const c of after.get(zone)) placed.add(cellKey(c.q, c.r))

  const out = new Map(after)
  for (const group of stranded) {
    const cells = []
    for (const zone of group) for (const c of after.get(zone)) cells.push(c)

    const offset = OFFSETS.find((o) => {
      let touches = false
      for (const c of cells) {
        const q = c.q + o.dq
        const r = c.r + o.dr
        const k = cellKey(q, r)
        if (k === ship || placed.has(k)) return false
        if (hexDistance({ q, r }, ORIGIN) >= POOL_RINGS) return false
        if (touches) continue
        for (const [nq, nr] of HEX_DIRS) {
          if (placed.has(cellKey(q + nq, r + nr))) {
            touches = true
            break
          }
        }
      }
      return touches
    })
    if (!offset) return null

    for (const zone of group) {
      const moved = translateCells(after.get(zone), offset.dq, offset.dr)
      out.set(zone, moved)
      for (const c of moved) placed.add(cellKey(c.q, c.r))
    }
  }
  return out
}
