/**
 * Where the astronauts are allowed to walk.
 *
 * The colony is a scattering of convex obstacles on flat ground, which is the case a grid
 * handles well and cheaply: buildings and the ship are rasterised into a blocked bitmap
 * whenever the roster changes, and agents route across it with A*.
 *
 * There are two independent guarantees here, and both matter:
 *
 * 1. **Routing** — A* finds a way around a building rather than through it, including
 *    threading the gaps between a ring of them. Paths are string-pulled afterwards so an
 *    astronaut walks a straight line where it can rather than a visible staircase.
 * 2. **Collision** — `slide()` is applied to every step regardless of whether the agent is
 *    following a path. Routing can fail (a site that got walled in between polls, a path
 *    budget that has not caught up yet); walking through a wall must not be what happens
 *    when it does.
 *
 * Search scratch is reused across calls and invalidated by a generation stamp rather than
 * being cleared, so a path costs no allocation and no 50k-element memset.
 */

/** Cell size, in metres. Small enough to resolve the gaps between neighbouring buildings. */
const CELL = 0.5
/** Half-width of the navigable square. Comfortably contains the colony and the landing pad. */
const HALF = 56
/** Give up rather than stall the frame if a search goes pathological. */
const MAX_EXPANSIONS = 24000

const SQRT2 = Math.SQRT2
/** Scratch for the solid queries, so the frame loop allocates nothing. */
const _near = []

export class Navigation {
  constructor() {
    this.cell = CELL
    this.half = HALF
    this.size = Math.ceil((HALF * 2) / CELL)
    const n = this.size * this.size

    this.blocked = new Uint8Array(n)
    this.gScore = new Float32Array(n)
    this.parent = new Int32Array(n)
    this.stamp = new Int32Array(n) // which search last touched this node
    this.closed = new Uint8Array(n)

    this.heap = new Int32Array(n)
    this.heapKey = new Float32Array(n)
    this.heapSize = 0

    this.generation = 0
    /** Bumped on every rebuild; agents use it to notice their path is stale. */
    this.version = 0
    /**
     * The obstacles that are walls to lean on, not just cells to route round: buildings,
     * with a `keep` radius the crew is pushed back out to. The grid alone cannot hold that
     * line — its cells are blocked at 80% of a footprint so the gaps between slots stay
     * walkable, and a half-cell of rounding on top of that lets an astronaut settle with
     * a shoulder through the wall.
     */
    this.solids = []
    /** The solids bucketed on a coarse grid, so a query only looks at its neighbourhood. */
    this._solidBuckets = new Map()
    this._bucket = 4
  }

  _bucketKey(bx, bz) {
    return bx * 100003 + bz
  }

  /** Solids are inserted in every bucket they touch; query just this bucket, once each. */
  _solidsNear(x, z, out) {
    out.length = 0
    const b = this._bucket
    const bx = Math.floor(x / b)
    const bz = Math.floor(z / b)
    const list = this._solidBuckets.get(this._bucketKey(bx, bz))
    if (list) for (let i = 0; i < list.length; i++) out.push(list[i])
    return out
  }

  // ── grid <-> world ──────────────────────────────────────────────────────────────────

  toCell(v) {
    return Math.floor((v + this.half) / this.cell)
  }

  toWorld(i) {
    return i * this.cell - this.half + this.cell * 0.5
  }

  inBounds(ix, iz) {
    return ix >= 0 && iz >= 0 && ix < this.size && iz < this.size
  }

  /** True where an astronaut may not stand. Outside the grid counts as blocked. */
  isBlocked(x, z) {
    const ix = this.toCell(x)
    const iz = this.toCell(z)
    if (!this.inBounds(ix, iz)) return true
    return this.blocked[iz * this.size + ix] === 1
  }

  // ── building the map ────────────────────────────────────────────────────────────────

  /**
   * Rasterise the obstacle list. Each is a circle `{ x, z, r }`, already inflated by the
   * caller for the astronaut's own width — doing it here would hide the one number that
   * decides whether the gaps between buildings stay walkable.
   */
  rebuild(obstacles) {
    this.blocked.fill(0)
    const { size, cell } = this
    this.solids = obstacles.filter((o) => o.keep > 0)
    // Bucket them. A solid lands in every bucket its keep circle touches, so a point only
    // ever has to look at its own bucket. Scanning neighbouring buckets would apply the
    // same obstacle's repulsion several times, especially at bucket boundaries.
    this._solidBuckets.clear()
    const b = this._bucket
    for (const o of this.solids) {
      const x0 = Math.floor((o.x - o.keep) / b)
      const x1 = Math.floor((o.x + o.keep) / b)
      const z0 = Math.floor((o.z - o.keep) / b)
      const z1 = Math.floor((o.z + o.keep) / b)
      for (let bx = x0; bx <= x1; bx++) {
        for (let bz = z0; bz <= z1; bz++) {
          const key = this._bucketKey(bx, bz)
          let list = this._solidBuckets.get(key)
          if (!list) this._solidBuckets.set(key, (list = []))
          list.push(o)
        }
      }
    }

    for (const o of obstacles) {
      const r = o.r
      if (!(r > 0)) continue
      const minX = Math.max(0, this.toCell(o.x - r))
      const maxX = Math.min(size - 1, this.toCell(o.x + r))
      const minZ = Math.max(0, this.toCell(o.z - r))
      const maxZ = Math.min(size - 1, this.toCell(o.z + r))
      // Test against the cell's centre, so a cell is blocked when its middle is inside the
      // obstacle rather than when it merely touches it — that is what keeps thin corridors.
      const r2 = r * r
      for (let iz = minZ; iz <= maxZ; iz++) {
        const wz = this.toWorld(iz)
        const dz = wz - o.z
        const row = iz * size
        for (let ix = minX; ix <= maxX; ix++) {
          const dx = this.toWorld(ix) - o.x
          if (dx * dx + dz * dz <= r2) this.blocked[row + ix] = 1
        }
      }
    }
    this.version++
    void cell
  }

  /**
   * A shove out of any solid the point is inside the keep radius of, as a velocity added
   * to `out`. Zero when clear. Firm enough to win against a crowd pressing inward, gentle
   * enough at the edge that nobody bounces off a wall.
   */
  repel(pos, out) {
    const solids = this._solidsNear(pos.x, pos.z, _near)
    for (let i = 0; i < solids.length; i++) {
      const o = solids[i]
      const dx = pos.x - o.x
      const dz = pos.z - o.z
      const keep = o.keep
      const d2 = dx * dx + dz * dz
      if (d2 >= keep * keep) continue
      const d = Math.sqrt(d2)
      if (d < 1e-4) {
        out.x += keep * 2
        continue
      }
      const strength = (1 - d / keep) * 6 + 0.4
      out.x += (dx / d) * strength
      out.z += (dz / d) * strength
    }
    return out
  }

  /**
   * The hard version of `repel`: a point inside a solid's keep radius is put back on it.
   * Applied after every move, so a crowd pressing inward can never win against a wall.
   */
  keepOut(pos) {
    const startX = pos.x
    const startZ = pos.z
    // Two keep circles that overlap make a pocket: out of one is into the other. A few
    // passes settle the easy cases; a point still inside after that is left where it was
    // rather than shoved back and forth, and the astronaut's own wobble check moves it.
    for (let pass = 0; pass < 3; pass++) {
      const solids = this._solidsNear(pos.x, pos.z, _near)
      let any = false
      for (let i = 0; i < solids.length; i++) {
        const o = solids[i]
        const dx = pos.x - o.x
        const dz = pos.z - o.z
        const keep = o.keep
        const d2 = dx * dx + dz * dz
        if (d2 >= keep * keep) continue
        const d = Math.sqrt(d2)
        if (d < 1e-4) {
          pos.x = o.x + keep
          continue
        }
        const nx = o.x + (dx / d) * keep
        const nz = o.z + (dz / d) * keep
        any = true
        if (!this.isBlocked(nx, nz)) {
          pos.x = nx
          pos.z = nz
          continue
        }
        // Straight out is walled off — a crate against the building, say. Look round the
        // keep circle for the nearest open spot and edge toward it, a little a frame, so the
        // astronaut walks out of the pocket rather than teleporting.
        const a0 = Math.atan2(dz, dx)
        for (let k = 1; k <= 9; k++) {
          const da = k * 0.2
          for (const sgn of [1, -1]) {
            const a = a0 + sgn * da
            const tx = o.x + Math.cos(a) * keep
            const tz = o.z + Math.sin(a) * keep
            if (this.isBlocked(tx, tz)) continue
            const len = Math.hypot(tx - pos.x, tz - pos.z) || 1
            const step = Math.min(len, 0.05)
            const sx = pos.x + ((tx - pos.x) / len) * step
            const sz = pos.z + ((tz - pos.z) / len) * step
            // The way there has to be open too, or this and `slide` trade the point back
            // and forth across a blocked cell for ever.
            if (this.isBlocked(sx, sz)) continue
            pos.x = sx
            pos.z = sz
            k = 99
            break
          }
        }
      }
      if (!any) break
    }
    if (this.insideKeep(pos.x, pos.z) && this.insideKeep(startX, startZ)) {
      pos.x = startX
      pos.z = startZ
      return 0
    }
    // How far the point was put back, so a walk can tell a step that was undone from one
    // that landed.
    return Math.hypot(pos.x - startX, pos.z - startZ)
  }

  /**
   * The nearest spot that is neither a blocked cell nor inside any keep circle — somewhere
   * an astronaut can stand without anything pushing it. Searched on rings out to `maxR`.
   */
  nearestClear(x, z, maxR = 5, allowed = () => true) {
    if (!this.isBlocked(x, z) && !this.insideKeep(x, z) && allowed(x, z)) return { x, z }
    for (let r = 0.35; r <= maxR; r += 0.35) {
      const n = Math.max(8, Math.round(r * 14))
      const a0 = (r * 7.3) % (Math.PI * 2)
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2
        const cx = x + Math.cos(a) * r
        const cz = z + Math.sin(a) * r
        if (this.isBlocked(cx, cz) || this.insideKeep(cx, cz)) continue
        if (!allowed(cx, cz)) continue
        return { x: cx, z: cz }
      }
    }
    return null
  }

  /** Whether a point is inside any solid's keep radius — no place to aim a walk at. */
  insideKeep(x, z) {
    const solids = this._solidsNear(x, z, _near)
    for (let i = 0; i < solids.length; i++) {
      const o = solids[i]
      const dx = x - o.x
      const dz = z - o.z
      if (dx * dx + dz * dz < o.keep * o.keep) return true
    }
    return false
  }

  /** Short local walks must clear both the routing grid and the visible walls. */
  clearWalk(x0, z0, x1, z1) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (CELL * 0.5)))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const x = x0 + (x1 - x0) * t
      const z = z0 + (z1 - z0) * t
      if (this.isBlocked(x, z) || this.insideKeep(x, z)) return false
    }
    return true
  }

  /**
   * The nearest walkable cell to a point, searched in expanding rings. Used both for a goal
   * that has been built over and for an agent that a new building landed on top of.
   */
  nearestFree(x, z, maxRings = 24) {
    const cx = this.toCell(x)
    const cz = this.toCell(z)
    if (this.inBounds(cx, cz) && this.blocked[cz * this.size + cx] === 0) return { ix: cx, iz: cz }

    for (let ring = 1; ring <= maxRings; ring++) {
      let best = null
      let bestD = Infinity
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // Only the shell of the ring; the inside was covered by earlier iterations.
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
          const ix = cx + dx
          const iz = cz + dz
          if (!this.inBounds(ix, iz)) continue
          if (this.blocked[iz * this.size + ix] === 1) continue
          const d = dx * dx + dz * dz
          if (d < bestD) {
            bestD = d
            best = { ix, iz }
          }
        }
      }
      if (best) return best
    }
    return null
  }

  // ── line of sight ───────────────────────────────────────────────────────────────────

  /** Sampled along the segment at half-cell steps — dense enough that nothing slips through. */
  lineOfSight(x0, z0, x1, z1) {
    const dx = x1 - x0
    const dz = z1 - z0
    const dist = Math.hypot(dx, dz)
    const steps = Math.ceil(dist / (this.cell * 0.5))
    if (steps === 0) return !this.isBlocked(x0, z0)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      if (this.isBlocked(x0 + dx * t, z0 + dz * t)) return false
    }
    return true
  }

  // ── A* ──────────────────────────────────────────────────────────────────────────────

  /**
   * A route from one world point to another, as world-space waypoints, or `null` if there
   * is no way through. The returned path excludes the start and ends exactly on the goal.
   */
  findPath(sx, sz, tx, tz) {
    const start = this.nearestFree(sx, sz)
    const goal = this.nearestFree(tx, tz)
    if (!start || !goal) return null

    const size = this.size
    const startIdx = start.iz * size + start.ix
    const goalIdx = goal.iz * size + goal.ix

    // A goal that has been built over — a stand position a new building landed on, or a
    // point simply inside a wall — resolves to the nearest walkable spot. Routing to the
    // requested point instead would end every such path with a leg through the obstacle.
    const reachableX = this.isBlocked(tx, tz) ? this.toWorld(goal.ix) : tx
    const reachableZ = this.isBlocked(tx, tz) ? this.toWorld(goal.iz) : tz

    // Straight shot: by far the common case in an open colony, and it skips the search.
    if (this.lineOfSight(sx, sz, reachableX, reachableZ)) return [{ x: reachableX, z: reachableZ }]

    const gen = ++this.generation
    const { gScore, parent, stamp, closed } = this
    this.heapSize = 0

    gScore[startIdx] = 0
    parent[startIdx] = -1
    stamp[startIdx] = gen
    closed[startIdx] = 0
    this._push(startIdx, this._heuristic(start.ix, start.iz, goal.ix, goal.iz))

    let expansions = 0
    let found = false
    // The node that got nearest the goal, for when the goal turns out to be unreachable —
    // a route to the closest point beats no route, which is a straight line into a wall.
    let best = startIdx
    let bestH = this._heuristic(start.ix, start.iz, goal.ix, goal.iz)

    while (this.heapSize > 0) {
      const current = this._pop()
      if (closed[current] === 1) continue
      closed[current] = 1
      if (current === goalIdx) {
        found = true
        break
      }
      if (++expansions > MAX_EXPANSIONS) break

      const cx = current % size
      const cz = (current - cx) / size
      const g = gScore[current]
      const h = this._heuristic(cx, cz, goal.ix, goal.iz)
      if (h < bestH) {
        bestH = h
        best = current
      }

      for (let k = 0; k < 8; k++) {
        const nx = cx + NEIGHBOURS[k * 2]
        const nz = cz + NEIGHBOURS[k * 2 + 1]
        if (!this.inBounds(nx, nz)) continue
        const nIdx = nz * size + nx
        if (this.blocked[nIdx] === 1) continue
        if (stamp[nIdx] === gen && closed[nIdx] === 1) continue

        // No corner cutting: a diagonal is only legal when both of its orthogonal
        // neighbours are clear, or agents will clip the corners of buildings.
        const diagonal = k >= 4
        if (diagonal) {
          if (this.blocked[cz * size + nx] === 1 || this.blocked[nz * size + cx] === 1) continue
        }

        const tentative = g + (diagonal ? SQRT2 : 1)
        if (stamp[nIdx] === gen && tentative >= gScore[nIdx]) continue

        stamp[nIdx] = gen
        closed[nIdx] = 0
        gScore[nIdx] = tentative
        parent[nIdx] = current
        this._push(nIdx, tentative + this._heuristic(nx, nz, goal.ix, goal.iz))
      }
    }

    // Unreachable, or the search ran out: go as far as it got. If that is nowhere, null.
    const endIdx = found ? goalIdx : best
    if (!found && best === startIdx) return null

    // Walk the parents back, then smooth.
    const cells = []
    let node = endIdx
    while (node !== -1) {
      cells.push(node)
      node = parent[node]
    }
    cells.reverse()
    const ex = found ? reachableX : this.toWorld(endIdx % size)
    const ez = found ? reachableZ : this.toWorld((endIdx - (endIdx % size)) / size)
    return this._smooth(cells, sx, sz, ex, ez)
  }

  /** Octile distance — admissible for 8-connected movement, and never overestimates. */
  _heuristic(ax, az, bx, bz) {
    const dx = Math.abs(ax - bx)
    const dz = Math.abs(az - bz)
    return dx + dz + (SQRT2 - 2) * Math.min(dx, dz)
  }

  /**
   * String-pulling: keep the furthest waypoint still visible from the last kept one. Turns
   * a staircase of grid cells into the handful of corners an astronaut actually needs.
   */
  _smooth(cells, sx, sz, tx, tz) {
    const size = this.size
    const pts = cells.map((idx) => {
      const ix = idx % size
      const iz = (idx - ix) / size
      return { x: this.toWorld(ix), z: this.toWorld(iz) }
    })
    // The true endpoints, not their cell centres.
    pts[pts.length - 1] = { x: tx, z: tz }

    const out = []
    let fromX = sx
    let fromZ = sz
    let i = 0
    while (i < pts.length) {
      // Keep the furthest waypoint still visible from here; `i` itself is the floor, and it
      // is always reachable because consecutive cells in an A* result are adjacent.
      let furthest = i
      for (let j = pts.length - 1; j > i; j--) {
        if (this.lineOfSight(fromX, fromZ, pts[j].x, pts[j].z)) {
          furthest = j
          break
        }
      }
      const p = pts[furthest]
      out.push(p)
      fromX = p.x
      fromZ = p.z
      if (furthest === pts.length - 1) break
      i = furthest + 1
    }
    return out.length ? out : [{ x: tx, z: tz }]
  }

  // ── movement ────────────────────────────────────────────────────────────────────────

  /**
   * Apply a step with collision. Blocked head-on, the move is retried on each axis alone so
   * the agent slides along the obstacle instead of stopping dead against it.
   *
   * This runs on every step whether or not a path is being followed, which is what makes
   * "never walks through a building" a property of the movement rather than a property of
   * the pathfinder having succeeded.
   */
  slide(pos, dx, dz) {
    // An agent a building was dropped on top of has no legal move at all; walk it out.
    if (this.isBlocked(pos.x, pos.z)) {
      const free = this.nearestFree(pos.x, pos.z)
      if (free) {
        const fx = this.toWorld(free.ix)
        const fz = this.toWorld(free.iz)
        const len = Math.hypot(fx - pos.x, fz - pos.z) || 1
        const step = Math.min(len, Math.hypot(dx, dz) + 0.04)
        pos.x += ((fx - pos.x) / len) * step
        pos.z += ((fz - pos.z) / len) * step
      }
      return false
    }

    const nx = pos.x + dx
    const nz = pos.z + dz
    if (!this.isBlocked(nx, nz)) {
      pos.x = nx
      pos.z = nz
      return true
    }
    if (dx !== 0 && !this.isBlocked(nx, pos.z)) {
      pos.x = nx
      return true
    }
    if (dz !== 0 && !this.isBlocked(pos.x, nz)) {
      pos.z = nz
      return true
    }
    return false
  }

  // ── heap ────────────────────────────────────────────────────────────────────────────

  _push(node, key) {
    let i = this.heapSize++
    this.heap[i] = node
    this.heapKey[i] = key
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.heapKey[p] <= this.heapKey[i]) break
      this._swap(i, p)
      i = p
    }
  }

  _pop() {
    const top = this.heap[0]
    const last = --this.heapSize
    this.heap[0] = this.heap[last]
    this.heapKey[0] = this.heapKey[last]
    let i = 0
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let small = i
      if (l < this.heapSize && this.heapKey[l] < this.heapKey[small]) small = l
      if (r < this.heapSize && this.heapKey[r] < this.heapKey[small]) small = r
      if (small === i) break
      this._swap(i, small)
      i = small
    }
    return top
  }

  _swap(a, b) {
    const n = this.heap[a]
    this.heap[a] = this.heap[b]
    this.heap[b] = n
    const k = this.heapKey[a]
    this.heapKey[a] = this.heapKey[b]
    this.heapKey[b] = k
  }
}

// Orthogonals first, then diagonals — the loop relies on index >= 4 meaning diagonal.
const NEIGHBOURS = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1])
