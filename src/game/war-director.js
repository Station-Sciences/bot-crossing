import * as THREE from 'three'
import { createHelicopter, createTank, dispose } from '../world/arsenal.js'
import { mayObey } from '../agents/war-orders.js'
import { MARCH_MS, downAt, mulberry32, phaseAt, planBattle } from './war.js'

/**
 * The war director: turns a battle plan into a battle on screen.
 *
 * `planBattle` says who falls when and who wins; this decides which of the bots this screen can
 * see plays each part, where they stand, and what flies overhead. Every frame it works out the
 * phase from the wall clock and re-issues each fighter's orders as they stand right now, so a
 * page reloaded mid-fight, a friend's bot that turns up late, or a thread that wakes and walks
 * off all simply come out right on the next frame rather than needing a story of their own.
 *
 * It only ever *asks*: orders go through `astronauts.setWarOrders`, which refuses any bot whose
 * thread is busy. Nothing here touches a thread, a building, a plot or the colony file.
 *
 * The rules — rosters, formations, the knockout shuffle, vehicle paths — are plain functions at
 * the top, so they run under node; the class at the bottom is the part with pictures in it.
 */

/** How far each side's swordsmen stand back from the line, and its gunners. Rows step back by ROW_GAP. */
export const SWORD_DEPTH = 1.6
export const GUN_DEPTH = 6.5
const ROW_GAP = 1.4
const FILE_GAP = 1.7
const PER_ROW = 8
/** How loose the rank is: a parade ground in straight lines reads as a chart, not a battle. */
const JITTER = 0.2
/** How far outside the defender's footprint the line is drawn. */
const MARGIN = 6
/** Tanks roll from START to DEPTH short of the line; helicopters set off from over their own rank. */
export const TANK_DEPTH = 10
const TANK_START = 18
const TANK_GAP = 5.5
const HELI_START = 14
const HELI_ORBIT = 12
const HELI_SPIN = 0.3 // radians a second round the battle point

const SIDES = ['attack', 'defend']
const other = (side) => (side === 'attack' ? 'defend' : 'attack')
/** Attackers stand back toward their own colony, defenders toward theirs. */
const back = (side) => (side === 'attack' ? -1 : 1)

export const homeSide = (side) => (SIDES.includes(side) ? side : null)

/** Sorted by plain code-unit order, not locale, so every machine lines the same bots up the same way. */
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The bots that may fight for one colony: home's (`neighborId` null) or one friend's. The same
 * test the bots themselves apply to an order — idle or asleep, and out on their feet — so a part
 * is never handed to a bot still queued in the ship, coming down the ramp, in your hand or on its
 * way home. On a page loaded mid-battle that is everyone at first; they join as they step out,
 * rather than holding slots from inside the ship where the knockouts and the guns cannot reach them.
 */
export function eligibleFighters(agents, neighborId) {
  return agents
    .filter((a) => mayObey(a) && (neighborId == null ? !a.neighbor : a.neighbor?.id === neighborId))
    .map((a) => a.id)
    .sort(byId)
}

/**
 * Who holds each of a side's `count` slots this frame. A slot is a part in the plan — its weapon,
 * its place in the rank, when it falls — so a fighter keeps its slot for the whole battle: if one
 * bot's thread wakes and it walks off, the rest do not shuffle along into new parts (and a bot that
 * is down does not suddenly stand up because the one beside it left). The first fill is simply the
 * first `count` by id; an empty slot is filled from whoever is free, where `canFill(i)` allows.
 */
export function fillSlots(slots, eligible, count, canFill = () => true) {
  const free = new Set(eligible)
  const vacated = []
  const out = Array.from({ length: count }, (_, i) => {
    const id = slots[i] ?? null
    if (id !== null && free.has(id)) {
      free.delete(id)
      return id
    }
    if (id !== null) vacated.push(id)
    return null
  })
  // Anyone past the end of a shorter list is out too.
  for (let i = count; i < slots.length; i++) if (slots[i] != null && !out.includes(slots[i])) vacated.push(slots[i])
  const queue = eligible.filter((id) => free.has(id))
  for (let i = 0; i < count && queue.length; i++) if (out[i] === null && canFill(i)) out[i] = queue.shift()
  return { slots: out, vacated }
}

/** Alternating, so every side gets the same mix and nobody has to choose. */
export const weaponFor = (i) => (i % 2 ? 'sword' : 'gun')

/**
 * Where the two sides meet: on the line from the attacker's colony to the defender's, just outside
 * the defender's footprint. `dir` points from attacker to defender; `normal` runs along the line.
 * Squeezed toward the middle when the two are too close for the full margin, so it never ends up
 * behind the attacker.
 */
export function battleGround({ from, to, toRadius }) {
  let dx = to.x - from.x
  let dz = to.z - from.z
  let d = Math.hypot(dx, dz)
  if (d < 1e-6) {
    dx = 0
    dz = 1
    d = 1
  }
  const dir = { x: dx / d, z: dz / d }
  const gap = Math.min(toRadius + MARGIN, d * 0.7)
  return {
    point: { x: to.x - dir.x * gap, z: to.z - dir.z * gap },
    dir,
    normal: { x: -dir.z, z: dir.x },
  }
}

/** A small, fixed wobble per slot in [-1, 1]: the same on every frame, so the rank does not shimmer. */
function wobble(side, i, salt) {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + (side === 'attack' ? 7 : 13), 0x85ebca6b)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return ((h >>> 0) / 4294967295) * 2 - 1
}

/** A point `depth` back from the line on `side`'s side and `lateral` along it. */
function at(ground, side, depth, lateral) {
  const s = back(side)
  return {
    x: ground.point.x + ground.dir.x * s * depth + ground.normal.x * lateral,
    z: ground.point.z + ground.dir.z * s * depth + ground.normal.z * lateral,
  }
}

/**
 * Where slot `i` of `n` stands: swordsmen at the line, gunners 6–8 back where they can shoot over
 * them, each in rows of up to eight, staggered, loosened a little. Both sides use the same files,
 * so a swordsman starts across the line from the one he will fight.
 */
export function rankSpot(ground, side, i, n) {
  const gun = weaponFor(i) === 'gun'
  const j = Math.floor(i / 2)
  const m = gun ? Math.ceil(n / 2) : Math.floor(n / 2)
  const row = Math.floor(j / PER_ROW)
  const inRow = Math.min(PER_ROW, m - row * PER_ROW)
  const k = j % PER_ROW
  const lateral = (k - (inRow - 1) / 2) * FILE_GAP + (row % 2 ? FILE_GAP / 2 : 0) + wobble(side, i, 1) * JITTER
  const depth = (gun ? GUN_DEPTH : SWORD_DEPTH) + row * ROW_GAP + wobble(side, i, 2) * JITTER
  return at(ground, side, depth, lateral)
}

/**
 * Which slot takes the plan's k-th knockout on a side. Shuffled with the battle's own seed, so
 * the falls come scattered through the rank rather than sweeping along it in id order — and the
 * same seed shuffles the same way on every screen.
 */
export function knockoutOrder(seed, side, n) {
  const rand = mulberry32((seed ^ (side === 'attack' ? 0x5bd1e995 : 0x27d4eb2f)) >>> 0)
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

/** The slots on `side` that are down by `now`. */
export function downSlots(plan, side, startedAt, now, order) {
  const out = new Set()
  for (const index of downAt(plan, side, startedAt, now)) if (order[index] !== undefined) out.add(order[index])
  return out
}

export function nearest(pos, list) {
  let best = null
  let bestD = Infinity
  for (const p of list) {
    if (!p) continue
    const d = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

/**
 * One fighter's orders for this frame, or null for none. `target` is the nearest enemy still on
 * its feet, if there is one. A loser still standing when the fight ends falls back to its rank
 * rather than cheering; a fallen fighter stays down until the cheer is over.
 */
export function fighterOrders({ phase, ground, side, slot, n, winner, down, target }) {
  if (phase !== 'march' && phase !== 'fight' && phase !== 'cheer') return null
  const goal = rankSpot(ground, side, slot, n)
  const s = -back(side)
  const ahead = { x: goal.x + ground.dir.x * s * 10, z: goal.z + ground.dir.z * s * 10 }
  const weapon = weaponFor(slot)
  if (down && phase !== 'march') return { goal, weapon, action: 'down', face: null }
  if (phase === 'fight') return { goal, weapon, action: 'fight', face: target ? { x: target.x, z: target.z } : ahead }
  if (phase === 'cheer' && side === winner) return { goal, weapon, action: 'cheer', face: ahead }
  return { goal, weapon, action: 'march', face: ahead }
}

const smooth = (u) => {
  const c = Math.min(1, Math.max(0, u))
  return c * c * (3 - 2 * c)
}

/** Tank `k` of `n`, `progress` 0 (just rolled out behind the rank) to 1 (in position, 10 short of the line). */
export function tankSpot(ground, side, k, n, progress) {
  const depth = TANK_START + (TANK_DEPTH - TANK_START) * smooth(progress)
  return at(ground, side, depth, (k - (n - 1) / 2) * TANK_GAP)
}

/**
 * Helicopter `k` of a side, `t` seconds into the battle: it lifts off over its own rank and spirals
 * in onto a circle round the battle point during the march, then keeps going round. The two sides
 * fly opposite ways on different circles and heights so they never meet. `heading` is a yaw for a
 * model facing +Z; `bank` is a roll into the turn.
 */
export function heliSpot(ground, side, k, t) {
  const start = at(ground, side, HELI_START, (k - 1) * 4)
  const sx = start.x - ground.point.x
  const sz = start.z - ground.point.z
  const r0 = Math.hypot(sx, sz)
  const r1 = HELI_ORBIT + k * 2.5 + (side === 'defend' ? 1.25 : 0)
  const spin = side === 'attack' ? HELI_SPIN : -HELI_SPIN
  const r = r0 + (r1 - r0) * smooth(t / (MARCH_MS / 1000))
  const angle = Math.atan2(sz, sx) + spin * t
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  // The way it is going is along the circle: d/dθ of (cos, sin), in the direction of the spin.
  const vx = -sin * Math.sign(spin)
  const vz = cos * Math.sign(spin)
  return {
    x: ground.point.x + cos * r,
    z: ground.point.z + sin * r,
    height: 9 + ((k + (side === 'defend' ? 1 : 0)) % 3),
    heading: Math.atan2(vx, vz),
    // Going round from +x toward +z, the centre is off its -x side, and a positive roll dips that
    // side; the other way round, the other way. Either way it leans into the turn.
    bank: spin > 0 ? 0.22 : -0.22,
  }
}

// ── on screen ─────────────────────────────────────────────────────────────────────────────

/** Your side's machines are in the colony's warm orange, the other side's in a cool blue. */
const HOME_ACCENT = 0xd9734a
const ENEMY_ACCENT = 0x4f86c6
const SHOT = { gun: new THREE.Color(2.6, 2.1, 0.9), tank: new THREE.Color(3, 1.5, 0.5), heli: new THREE.Color(2.8, 1.2, 0.8) }
const CLASH = new THREE.Color(1, 1, 1.1)
const SHELL_SPEED = 45
const angleTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z)
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

export class WarDirector {
  /** `colony` supplies the bots, the particles, the ground and where everyone's colony is. */
  constructor(colony) {
    this.colony = colony
    this.group = new THREE.Group()
    this.group.name = 'war'
    colony.scene.add(this.group)
    this.battle = null
    this.phase = null
    this._reset()
    this._v = new THREE.Vector3()
    this._w = new THREE.Vector3()
  }

  _reset() {
    this.plan = null
    this.home = null
    this.enemyId = null
    this.slots = { attack: [], defend: [] }
    this.order = { attack: [], defend: [] }
    this.vehicles = []
    this.ground = null
    this.done = false
    this.phase = null
    this._fx = new Map()
    this._impacts = []
  }

  /**
   * What battle is live, and which side home is on. Called again with the same battle it changes
   * nothing — the page can say it on every poll. `null` (or anything malformed) stands everyone down.
   */
  setBattle(battle, { side, enemyNeighborId } = {}) {
    const home = homeSide(side)
    if (!battle || !home || !enemyNeighborId) {
      this._end()
      this.battle = null
      this._reset()
      return
    }
    if (this.battle?.id === battle.id && this.home === home && this.enemyId === enemyNeighborId) return
    this._end()
    this._reset()
    this.battle = { id: battle.id, seed: battle.seed, startedAt: battle.startedAt, attackers: battle.attackers, defenders: battle.defenders }
    this.plan = planBattle(this.battle)
    this.home = home
    this.enemyId = enemyNeighborId
    this.order = { attack: knockoutOrder(battle.seed, 'attack', this.plan.count.attack), defend: knockoutOrder(battle.seed, 'defend', this.plan.count.defend) }
  }

  /** Everybody home and the machines put away. Orders only ever come from here, so all of them go. */
  _end() {
    if (this.slots.attack.some(Boolean) || this.slots.defend.some(Boolean)) this.colony.astronauts.clearWarOrders()
    this.slots = { attack: [], defend: [] }
    for (const v of this.vehicles) {
      this.group.remove(v.group)
      dispose(v.group)
    }
    this.vehicles = []
    this._fx.clear()
    this._impacts = []
  }

  /**
   * The line, drawn once per battle from where the two colonies are when it is first needed, then
   * held: a neighbour's settlement reshuffling mid-battle must not drag both ranks across the map.
   * Until the friend's settlement is on the map there is no line, and nothing is staged.
   */
  _ground() {
    if (this.ground) return this.ground
    const site = this.colony.neighborSites.find((s) => s.id === this.enemyId)
    if (site) {
      const home = { x: 0, z: 0 }
      this.ground = this.home === 'attack'
        ? battleGround({ from: home, to: site, toRadius: site.r })
        : battleGround({ from: site, to: home, toRadius: this.colony.homeReach() })
    }
    return this.ground
  }

  update(dt, now = Date.now()) {
    if (!this.battle || this.done) return
    const { phase, t } = phaseAt(this.plan, this.battle.startedAt, now)
    this.phase = phase
    if (phase === 'pending') return
    if (phase === 'over') {
      this._end()
      this.done = true
      return
    }
    const ground = this._ground()
    if (!ground) return

    const astronauts = this.colony.astronauts
    const live = { attack: [], defend: [] }
    const down = {}
    for (const side of SIDES) {
      const owner = side === this.home ? null : this.enemyId
      down[side] = downSlots(this.plan, side, this.battle.startedAt, now, this.order[side])
      // A bot that turns up during the march or the fight joins an empty part; nobody is recruited
      // to play a fighter who has already fallen, or to cheer for a fight they did not see.
      const canFill = (i) => phase !== 'cheer' && !down[side].has(i)
      const { slots, vacated } = fillSlots(this.slots[side], eligibleFighters(astronauts.agents, owner), this.plan.count[side], canFill)
      for (const id of vacated) {
        astronauts.setWarOrders(id, null)
        this._fx.delete(id)
      }
      this.slots[side] = slots
      slots.forEach((id, slot) => {
        const agent = id && astronauts.byId.get(id)
        if (agent) live[side].push({ agent, slot, standing: !down[side].has(slot) })
      })
    }

    // A bot that turns its order down is not in the fight this frame: nothing aims at it and it
    // fires at nothing. It keeps its slot, and is back the moment it takes an order again. Whoever
    // had picked it as a target picks again — a second issue of the same order keeps its clock, so
    // that costs nothing but the call, and only on a frame where somebody refused.
    for (let pass = 0; pass < 2; pass++) {
      let refused = false
      for (const side of SIDES) {
        const foes = live[other(side)].filter((f) => f.standing).map((f) => f.agent.pos)
        for (const f of live[side]) {
          f.target = nearest(f.agent.pos, foes)
          f.obeys = astronauts.setWarOrders(f.agent.id, fighterOrders({
            phase, ground, side, slot: f.slot, n: this.plan.count[side], winner: this.plan.winner,
            down: !f.standing, target: f.target,
          }))
          if (!f.obeys) refused = true
        }
      }
      for (const side of SIDES) live[side] = live[side].filter((f) => f.obeys)
      if (!refused) break
    }

    if (!this.vehicles.length) this._spawnVehicles()
    this._driveVehicles(dt, phase, t / 1000, ground, live)
    this._effects(dt, phase, live)
  }

  _spawnVehicles() {
    for (const side of SIDES) {
      const accent = side === this.home ? HOME_ACCENT : ENEMY_ACCENT
      const { tanks, helis } = this.plan.vehicles[side]
      for (let k = 0; k < tanks; k++) this._addVehicle('tank', side, k, tanks, createTank(accent))
      for (let k = 0; k < helis; k++) this._addVehicle('heli', side, k, helis, createHelicopter(accent))
    }
  }

  _addVehicle(kind, side, k, n, group) {
    if (kind === 'heli') group.rotation.order = 'YXZ'
    this.group.add(group)
    // Staggered, so a side's guns do not all go off on the same frame.
    this.vehicles.push({ kind, side, k, n, group, cool: 1 + k * 0.7 + Math.random(), burst: 0, recoil: 0, aim: 0 })
  }

  _driveVehicles(dt, phase, seconds, ground, live) {
    const colony = this.colony
    for (const v of this.vehicles) {
      const g = v.group
      const foes = live[other(v.side)].filter((f) => f.standing)
      if (v.kind === 'tank') {
        const p = tankSpot(ground, v.side, v.k, v.n, seconds / (MARCH_MS / 1000))
        const rolling = seconds < MARCH_MS / 1000
        g.position.set(p.x, colony.groundAt(p.x, p.z), p.z)
        const yaw = Math.atan2(ground.dir.x * -back(v.side), ground.dir.z * -back(v.side))
        g.rotation.y = yaw
        // The turret swings round onto whoever is nearest, at a turret's pace rather than a glance's.
        const foe = nearest(p, foes.map((f) => f.agent.pos))
        v.target = foe
        const want = wrap((foe ? angleTo(p, foe) : yaw) - yaw)
        const turn = wrap(want - v.aim)
        v.aim = wrap(v.aim + Math.sign(turn) * Math.min(Math.abs(turn), 1.4 * dt))
        g.userData.turret.rotation.y = v.aim
        v.recoil = Math.max(0, v.recoil - dt * 2.5)
        g.userData.barrel.rotation.x = -0.06
        g.userData.barrel.position.z = 0.4 - v.recoil * 0.3
        v.ready = Math.abs(turn) < 0.12
        if (rolling && colony.particles.enabled && Math.random() < dt * 6) {
          const side = Math.random() < 0.5 ? -0.7 : 0.7
          colony.particles.step(p.x + Math.cos(yaw) * side, g.position.y, p.z - Math.sin(yaw) * side, colony._dustTint, g.position.y)
        }
      } else {
        const h = heliSpot(ground, v.side, v.k, seconds)
        g.position.set(h.x, colony.groundAt(ground.point.x, ground.point.z) + h.height, h.z)
        g.rotation.set(0.08, h.heading, h.bank)
        g.userData.rotor.rotation.y += dt * 28
        g.userData.tailRotor.rotation.x += dt * 40
        v.target = nearest(h, foes.map((f) => f.agent.pos))
        v.ready = true
      }
      g.updateMatrixWorld(true)
      if (phase === 'fight') this._fireVehicle(v, dt)
    }
  }

  _fireVehicle(v, dt) {
    v.cool -= dt
    if (v.cool > 0 || !v.target || !v.ready) return
    const particles = this.colony.particles
    const from = v.group.userData.muzzle.getWorldPosition(this._v)
    const to = this._w.set(v.target.x + (Math.random() - 0.5) * 1.2, v.target.y + 0.3, v.target.z + (Math.random() - 0.5) * 1.2)
    if (v.kind === 'tank') {
      particles.tracer(from.x, from.y, from.z, to.x, to.y, to.z, SHOT.tank, 2.2, SHELL_SPEED)
      v.recoil = 1
      v.cool = 2.6 + Math.random() * 1.8
      // The shell lands when it gets there, not when it leaves.
      this._impacts.push({ in: from.distanceTo(to) / SHELL_SPEED, x: to.x, y: v.target.y, z: to.z })
    } else {
      particles.tracer(from.x, from.y, from.z, to.x, to.y, to.z, SHOT.heli, 1.2)
      // Short bursts of three, a beat apart.
      v.burst = (v.burst + 1) % 3
      v.cool = v.burst ? 0.13 : 1.2 + Math.random() * 1.2
    }
  }

  _effects(dt, phase, live) {
    const colony = this.colony
    const particles = colony.particles
    for (let i = this._impacts.length - 1; i >= 0; i--) {
      const hit = this._impacts[i]
      hit.in -= dt
      if (hit.in > 0) continue
      this._impacts.splice(i, 1)
      particles.puff(hit.x, hit.y, hit.z, colony._dustTint, 1.8, hit.y)
      particles.weld(hit.x, hit.y + 0.2, hit.z, SHOT.tank, hit.y)
    }
    if (!particles.enabled) return
    const astronauts = colony.astronauts
    for (const side of SIDES) {
      for (const f of live[side]) {
        const a = f.agent
        let fx = this._fx.get(a.id)
        if (!fx) this._fx.set(a.id, (fx = { cool: Math.random() * 1.2, dusted: false }))
        // A knockout lands in a cloud of dust, once, as it hits the floor.
        if (!f.standing) {
          if (!fx.dusted && (a.knock || 0) > 1.2) {
            fx.dusted = true
            particles.puff(a.pos.x, a.groundY || a.pos.y, a.pos.z, colony._dustTint, 1, a.groundY || 0)
          }
          continue
        }
        fx.dusted = false
        if (phase !== 'fight' || a.war?.action !== 'fight' || !f.target) continue
        if (a.war.weapon === 'gun') {
          fx.cool -= dt
          // Only once the gun is up and level: a bot still running into place does not fire.
          if (fx.cool > 0 || a.clipKey !== 'aim') continue
          const muzzle = astronauts.muzzleOf(a.id, this._v)
          if (!muzzle) continue
          fx.cool = 0.7 + Math.random() * 0.9
          const t = f.target
          particles.tracer(muzzle.x, muzzle.y, muzzle.z, t.x + (Math.random() - 0.5) * 0.6, t.y + 0.55 + (Math.random() - 0.5) * 0.3, t.z + (Math.random() - 0.5) * 0.6, SHOT.gun, 1)
        } else {
          // Blades meeting: a few sparks between the two when a swordsman is in reach.
          const t = f.target
          const d = Math.hypot(t.x - a.pos.x, t.z - a.pos.z)
          if (d < 1.9 && Math.random() < dt * 1.6) {
            particles.weld((a.pos.x + t.x) / 2, a.pos.y + 0.75, (a.pos.z + t.z) / 2, CLASH, a.groundY || 0)
          }
        }
      }
    }
  }

  dispose() {
    this._end()
    this.colony.scene.remove(this.group)
    this.battle = null
  }
}
