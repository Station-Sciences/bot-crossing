import * as THREE from 'three'
import { createBall, dispose } from '../world/arsenal.js'
import { Emotes } from '../agents/emotes.js'
import { mayMingle } from '../agents/scene-orders.js'
import { MAX_AGENT_CAP } from '../core/settings.js'
import { isErrandId } from './errands.js'
import { MOOD_MS, SCENE_MS, SocialPlanner, canSocialise, makeScene, near, partsAt } from './social.js'

/**
 * The social director: idle bots' social life, on screen.
 *
 * The planner (`social.js`) decides who gets together, when and for what; this is the part that
 * watches the colony for the things that set a scene off, hands every bot in a scene its step each
 * frame, pops the bubbles up beside their heads and kicks the ball about.
 *
 * Like the war director it only ever *asks*: steps go through `astronauts.setSceneOrders`, which
 * refuses any bot that is not idle and on its feet, or is at war. Nothing here touches a thread, a
 * building, a plot or the colony file, and nothing is shared — a friend's bots join in on this
 * screen only.
 *
 * The rules — what counts as an event, what the planner is told about a bot, where the ball is —
 * are plain functions at the top, so they run under node; the class at the bottom drives them.
 */

/** How often the planner is asked what has changed. Steps are applied every frame regardless. */
export const PLAN_EVERY_MS = 250
/** How long after a run stops working its bot may still go off to play when it reaches idle. */
export const FINISH_WINDOW_MS = 10 * 60 * 1000

/**
 * The zone a thread lives in, named as its plot is: a home repo's plot is called by the repo, a
 * friend's by `nb:<friend>/<repo>`. Matching the plot id is what lets an archived thread's event
 * find the repo-mates still standing on that plot.
 */
export function zoneOfThread(thread) {
  if (!thread) return null
  return thread.neighbor ? `nb:${thread.neighbor.id}/${thread.project}` : thread.project || 'unknown'
}

/**
 * What the planner is told about one bot. A thread that is idle but whose bot is not out on its
 * feet — still in the ship, on the ramp, in your hand, heading home — is passed on as `away`: the
 * bot would refuse every step, and an idle status would have the planner keep casting it.
 */
export function plannerBot(agent, zone = null) {
  return {
    id: agent.id,
    status: agent.status === 'idle' && !mayMingle(agent) ? 'away' : agent.status,
    pos: { x: agent.pos.x, z: agent.pos.z },
    zone: zone ?? null,
    owner: agent.neighbor ? agent.neighbor.id : 'home',
    atWar: Boolean(agent.war),
  }
}

/**
 * Runs that just finished: a bot that reaches `idle` whose last status other than `waiting` was
 * `working`, and that stopped working no more than FINISH_WINDOW_MS ago. A run usually ends on
 * waiting — unread until you look — and only goes idle once you have read it, so the wait between
 * is looked through; a run that stopped stuck, or a bot that was never working, is not a run
 * finishing, and one read ten minutes on is old news.
 *
 * `before` is what the last look returned, per bot: its status, its last status other than
 * waiting, and when it stopped working. Returns the events and the same to compare against next
 * time; a bot seen for the first time is only remembered, since nothing about it has changed yet.
 */
export function statusEvents(before, agents, now = Date.now()) {
  const seen = new Map()
  const events = []
  for (const a of agents) {
    const was = before.get(a.id)
    const last = a.status === 'waiting' ? (was?.last ?? null) : a.status
    const leftAt = was?.status === 'working' && a.status !== 'working' ? now : (was?.leftAt ?? null)
    seen.set(a.id, { status: a.status, last, leftAt })
    const finished = was && was.status !== 'idle' && a.status === 'idle' && was.last === 'working'
    if (finished && leftAt != null && now - leftAt <= FINISH_WINDOW_MS) events.push({ kind: 'finished', id: a.id })
  }
  return { events, seen }
}

/**
 * Threads that left: one `archived` event per zone that lost one, so a repo cleared out in one go
 * gets one heartbreak rather than a plot of bots in tears.
 *
 * Home (`before`/`after` are the colony's live threads, `scan` everything scanned): a thread counts
 * when it was archived, or vanished from the scan altogether. One that is still scanned but was
 * hidden, or folded away as dormant, has not gone anywhere — it is only off the map.
 *
 * Friends (`friendsBefore`/`friendsAfter`, each friend's `shared` from `hydrateNeighbors`: every
 * thread they share, drawn or not, by id → repo): a thread counts when it disappears from what a
 * friend shares while that friend still shares something. Only the drawn sixty are on the map, and
 * those are re-ranked on every poll, so a thread that merely dropped out of them has gone nowhere.
 * A friend whose whole settlement goes — removed, or offline — has not had a thread archived; nor
 * has one who lost more than half of theirs in one poll, which is a reset — a new key changes
 * every id at once — not a clear-out to grieve thread by thread.
 *
 * Errands never count: a subagent ending is the ordinary end of an errand, not a loss. A friend's
 * are not in `shared` at all.
 */
export function departureEvents({ before = new Map(), after = new Map(), scan = [], archivedIds = new Set(), friendsBefore = new Map(), friendsAfter = new Map() }) {
  const events = []
  const zones = new Set()
  const add = (owner, zone) => {
    const key = `${owner}\u0000${zone}`
    if (zones.has(key)) return
    zones.add(key)
    events.push({ kind: 'archived', zone, owner })
  }
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds)
  const scanned = new Map(scan.map((t) => [t.id, t]))
  for (const [id, thread] of before) {
    if (after.has(id) || isErrandId(id)) continue
    const now = scanned.get(id)
    if (!now || now.archived || archived.has(id)) add('home', zoneOfThread(thread))
  }
  for (const [friend, was] of friendsBefore) {
    const is = friendsAfter.get(friend)
    if (!was || !is?.size) continue
    const gone = [...was].filter(([id]) => !is.has(id))
    if (gone.length * 2 > was.size) continue
    for (const [, project] of gone) add(friend, zoneOfThread({ project, neighbor: { id: friend } }))
  }
  return events
}

/**
 * A battle's result as the planner hears it: home won or lost, and the friend it was against the
 * other way round. Only while the result is fresh — a battle that ended while this page was shut
 * is still counted on the next load, and a sulk about it an hour later would be about nothing.
 */
export function warEvents({ won, enemyId, endedAt = null }, now = Date.now()) {
  if (!enemyId || (endedAt != null && now - endedAt > MOOD_MS)) return []
  return [
    { kind: 'warResult', owner: 'home', won: Boolean(won) },
    { kind: 'warResult', owner: enemyId, won: !won },
  ]
}

/**
 * How far to move a scene so that it is played on open ground: `{ x, z }`, or null if nowhere near
 * will do. The planner places a scene between its cast, knowing nothing of buildings, so a ring
 * can come out drawn round a dome with everyone hidden behind it. The scene is kept whole — every
 * spot, and for a ring (a group, a game) its middle and the circle its players stand or run round,
 * have to be clear (`clear(x, z)`) — and moved as little as possible, nearest first. A pair's
 * middle is only somewhere between them, and a heartbroken bot sits where it already stands, so
 * neither is moved for ground nobody uses.
 */
export function sceneShift(scene, clear, { reach = 8, step = 0.5 } = {}) {
  const c = scene.centre
  const spots = Object.values(scene.spots || {})
  const ring = scene.kind === 'group' || scene.kind === 'play'
  const r = ring ? spots.reduce((m, p) => Math.max(m, Math.hypot(p.x - c.x, p.z - c.z)), 0) : 0
  const points = ring ? [c, ...spots] : spots
  for (let i = 0; i < 12 && r > 0; i++) {
    const a = (i / 12) * Math.PI * 2
    points.push({ x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r })
  }
  const fits = (dx, dz) => points.every((p) => clear(p.x + dx, p.z + dz))
  if (fits(0, 0)) return { x: 0, z: 0 }
  for (let d = step; d <= reach + 1e-9; d += step) {
    const n = Math.max(8, Math.round(d * 6))
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const dx = Math.cos(a) * d
      const dz = Math.sin(a) * d
      if (fits(dx, dz)) return { x: dx, z: dz }
    }
  }
  return null
}

/**
 * A step moved by a scene's shift: its goal and any point it faces. A bot it is told to look at is
 * a bot, wherever it stands, so an id is left alone. A goal that still lands somewhere it cannot
 * stand — an argument's walk-off, say, aimed into a wall — goes to the nearest place it can
 * (`nearest(x, z)`, or left as it is when that finds nothing).
 */
export function shiftStep(step, off, clear = () => true, nearest = () => null) {
  if (!step) return step
  const move = (p) => (p && typeof p === 'object' ? { x: p.x + off.x, z: p.z + off.z } : p)
  let goal = move(step.goal)
  if (goal && !clear(goal.x, goal.z)) goal = nearest(goal.x, goal.z) || goal
  return { ...step, goal, face: move(step.face) }
}

/** The ball's flight, in ms and world units. The kick connects a beat after the leg starts up. */
export const BALL = Object.freeze({
  HIT_MS: 150,
  FLIGHT_MS: 850,
  /** Where along the flight it lands the first time, and how much of the distance it has covered by then. */
  BOUNCE_K: 0.7,
  BOUNCE_S: 0.78,
  HEIGHT: 0.85,
  BOUNCE_HEIGHT: 0.22,
  /** How far in front of a player's feet the ball sits. */
  FOOT: 0.4,
  R: 0.175,
})

/**
 * One kick, `k` (0..1) of the way through its flight: how far along the ground it has come (0..1)
 * and how high it is. A lofted arc that lands short, then one low hop the rest of the way, slower,
 * as a ball that has lost something to the bounce.
 */
export function kickArc(k) {
  const { BOUNCE_K, BOUNCE_S, HEIGHT, BOUNCE_HEIGHT } = BALL
  if (k <= 0) return { s: 0, h: 0 }
  if (k >= 1) return { s: 1, h: 0 }
  if (k < BOUNCE_K) {
    const u = k / BOUNCE_K
    return { s: u * BOUNCE_S, h: 4 * HEIGHT * u * (1 - u) }
  }
  const u = (k - BOUNCE_K) / (1 - BOUNCE_K)
  return { s: BOUNCE_S + u * (1 - BOUNCE_S), h: 4 * BOUNCE_HEIGHT * u * (1 - u) }
}

/** A step in front of `from`, toward `to`: where the ball sits at a player's feet. */
function footOf(from, to) {
  if (!from) return to ? { x: to.x, z: to.z } : null
  const dx = (to?.x ?? from.x) - from.x
  const dz = (to?.z ?? from.z) - from.z
  const d = Math.hypot(dx, dz)
  if (d < 1e-6) return { x: from.x, z: from.z }
  const by = Math.min(BALL.FOOT, d / 2)
  return { x: from.x + (dx / d) * by, z: from.z + (dz / d) * by }
}

/**
 * Where the ball is at scene time `t` (ms): `{ x, z, h, flying }`, `h` above the ground.
 *
 * `passes` is the kick schedule as it stands — `scene.passesFor(scene.gone)`, so a pass never goes
 * to a player who has left. `where(id)` is a player's position now (null if it is not on the map),
 * and `spots` where each player is meant to stand, which is used until the first kick, while
 * everyone is still walking over. Before any kick it waits at the first kicker's spot; after the
 * last it rests at the last receiver's feet; with no kicks at all, in the middle.
 */
export function ballAt({ passes, spots = {}, centre }, t, where = () => null) {
  const at = (id) => where(id) || spots[id] || null
  if (!passes?.length) return { x: centre.x, z: centre.z, h: 0, flying: false }
  let i = -1
  for (let j = 0; j < passes.length && passes[j].at + BALL.HIT_MS <= t; j++) i = j
  if (i < 0) {
    const first = passes[0]
    const p = footOf(spots[first.from] || at(first.from), spots[first.to] || at(first.to)) || centre
    return { x: p.x, z: p.z, h: 0, flying: false }
  }
  const pass = passes[i]
  const from = at(pass.from)
  const to = at(pass.to)
  const a = footOf(from, to) || centre
  const b = footOf(to, from) || centre
  const k = Math.min(1, Math.max(0, (t - pass.at - BALL.HIT_MS) / BALL.FLIGHT_MS))
  const { s, h } = kickArc(k)
  return { x: a.x + (b.x - a.x) * s, z: a.z + (b.z - a.z) * s, h, flying: k < 1 }
}

/** How many a forced scene casts, when the dev hook is not told. */
const FORCE_SIZE = { chat: 2, argue: 2, heartbreak: 2, group: 4, play: 3 }
/** How long a bot left sitting by a scene that ended under it takes to get up before it goes. */
const STAND_UP_MS = 1500
const STAND = Object.freeze({ goal: null, face: null, action: 'stand', emote: null, expression: null })
/** A ball pops in when its game starts and shrinks away after, rather than blinking. */
const BALL_POP_S = 0.25

export class SocialDirector {
  /** `colony` supplies the bots, their plots, the ground and the settings. */
  constructor(colony) {
    this.colony = colony
    this.settings = colony.settings
    this.planner = new SocialPlanner()
    this.emotes = new Emotes(colony.scene, colony.settings, MAX_AGENT_CAP)
    this.group = new THREE.Group()
    this.group.name = 'social'
    colony.scene.add(this.group)
    /** Events since the planner last looked. */
    this.events = []
    /** Every bot's status as last seen (see `statusEvents`), for spotting a run that just finished. */
    this.statuses = new Map()
    /** Bots getting up off the ground after their scene ended under them: id → until (ms). */
    this.standing = new Map()
    /** A ball per game being played, by scene id. */
    this.balls = new Map()
    /** Where each scene is moved to so that it is played on open ground, by scene id. */
    this.shifts = new Map()
    this.planAt = 0
    this.on = false
    const nav = () => this.colony.nav
    this._clear = (x, z) => !nav() || (!nav().isBlocked(x, z) && !nav().insideKeep(x, z))
    this._nearest = (x, z) => nav()?.nearestClear(x, z, 4) ?? null
  }

  /** A scene's shift onto open ground, worked out once when it is first played. */
  _shift(scene) {
    let off = this.shifts.get(scene.id)
    if (!off) this.shifts.set(scene.id, (off = sceneShift(scene, this._clear) || { x: 0, z: 0 }))
    return off
  }

  get enabled() {
    return this.settings.get('socialLife') !== false
  }

  /** The planner's picture of every bot on the map. */
  _bots() {
    const buildings = this.colony.buildings
    return this.colony.astronauts.agents.map((a) => plannerBot(a, buildings.get(a.id)?.plot ?? null))
  }

  /**
   * The colony's roster just changed: anything that left is an event. Called from `setThreads`
   * with the live threads before and after, the whole scan, the archive list and what each friend
   * shares.
   */
  noteThreads(change) {
    if (!this.enabled) return
    this.events.push(...departureEvents(change))
  }

  /** A battle has been counted: the losers sulk and the winners play, for a minute. */
  noteWarResult(result, now = Date.now()) {
    if (!this.enabled) return
    this.events.push(...warEvents(result, now))
  }

  /**
   * One frame of social life, before the bots move: the planner asked a few times a second, and
   * every bot in a scene handed its step as it stands now — every frame, because a chase's goal
   * runs on ahead and a scene's turns change under bots that are already standing there.
   */
  update(now = Date.now()) {
    if (!this.enabled) {
      if (this.on) this._switchOff()
      return
    }
    this.on = true
    const astronauts = this.colony.astronauts

    if (now - this.planAt >= PLAN_EVERY_MS) {
      this.planAt = now
      // Statuses only change when a scan lands, seconds apart, so a look per planning step
      // misses no run that finishes.
      const seen = statusEvents(this.statuses, astronauts.agents, now)
      this.statuses = seen.seen
      this.events.push(...seen.events)
      const before = new Map(this.planner.active.map((s) => [s.id, s]))
      const events = this.events
      this.events = []
      const out = this.planner.tick({ now, bots: this._bots(), events })
      for (const { id } of out.left) astronauts.setSceneOrders(id, null)
      for (const sceneId of out.end) {
        this._ended(before.get(sceneId), now)
        this.shifts.delete(sceneId)
      }
    }

    for (const scene of this.planner.active) {
      const off = this._shift(scene)
      const parts = partsAt(scene, now)
      for (const id in parts) astronauts.setSceneOrders(id, shiftStep(parts[id], off, this._clear, this._nearest))
    }

    // Getting up, then off home. A bot that will not take the step any more has been called away.
    for (const [id, until] of this.standing) {
      if (now >= until || !astronauts.setSceneOrders(id, STAND)) {
        astronauts.setSceneOrders(id, null)
        this.standing.delete(id)
      }
    }
  }

  /**
   * A scene is over. Run to its end, everyone has already done its last step and simply goes. Cut
   * short — its other half was called away — a bot still sitting gets up before it goes, rather than
   * snapping to its feet mid-sob; anyone else just goes. (A battle needs no care here: its fighters'
   * scenes were ended the moment they took orders.)
   */
  _ended(scene, now) {
    if (!scene) return
    const astronauts = this.colony.astronauts
    const early = now < scene.startedAt + scene.durationMs
    for (const id of scene.cast) {
      if (scene.gone.includes(id)) continue
      const held = astronauts.byId.get(id)?.scene
      if (early && held?.action === 'sit' && astronauts.setSceneOrders(id, STAND)) {
        this.standing.set(id, now + STAND_UP_MS)
      } else {
        astronauts.setSceneOrders(id, null)
      }
    }
  }

  /** Social life switched off: every scene, step, bubble and ball gone at once. */
  _switchOff() {
    this.on = false
    this.planner.clear()
    this.planner.rest.clear()
    this.colony.astronauts.clearSceneOrders()
    this.standing.clear()
    this.shifts.clear()
    this.events = []
    this.statuses = new Map()
    for (const ball of this.balls.values()) this._dropBall(ball)
    this.balls.clear()
  }

  /**
   * After the bots have moved: the bubbles beside their heads, and the balls at their feet. Run
   * even with social life off, so the last bubbles shrink away instead of vanishing.
   */
  draw(dt, elapsed, now = Date.now()) {
    this.emotes.update(this.colony.astronauts.agents, elapsed, (a) => a.emote)
    this._balls(dt, now)
  }

  _balls(dt, now) {
    const games = new Map()
    if (this.on) for (const s of this.planner.active) if (s.variant === 'ball') games.set(s.id, s)
    for (const [id, scene] of games) {
      let ball = this.balls.get(id)
      if (!ball) this.balls.set(id, (ball = this._newBall()))
      this._kick(ball, scene, dt, now)
    }
    for (const [id, ball] of this.balls) {
      if (games.has(id)) continue
      ball.pop = Math.max(0, ball.pop - dt / BALL_POP_S)
      ball.holder.scale.setScalar(ball.pop)
      if (ball.pop === 0) {
        this._dropBall(ball)
        this.balls.delete(id)
      }
    }
  }

  _newBall() {
    // Spun about its own middle, so it rolls: `createBall` stands on its bottom.
    const holder = new THREE.Group()
    const spinner = new THREE.Group()
    spinner.position.y = BALL.R
    const ball = createBall()
    ball.position.y = -BALL.R
    spinner.add(ball)
    holder.add(spinner)
    holder.scale.setScalar(0)
    this.group.add(holder)
    return { holder, spinner, mesh: ball, pop: 0, placed: false, last: new THREE.Vector3(), axis: new THREE.Vector3(), q: new THREE.Quaternion() }
  }

  _dropBall(ball) {
    this.group.remove(ball.holder)
    dispose(ball.mesh)
  }

  _kick(ball, scene, dt, now) {
    const byId = this.colony.astronauts.byId
    const where = (id) => {
      const a = !scene.gone.includes(id) && byId.get(id)
      return a ? { x: a.pos.x, z: a.pos.z } : null
    }
    const off = this._shift(scene)
    const spots = {}
    for (const id in scene.spots) spots[id] = { x: scene.spots[id].x + off.x, z: scene.spots[id].z + off.z }
    const centre = { x: scene.centre.x + off.x, z: scene.centre.z + off.z }
    const p = ballAt({ passes: scene.passesFor(scene.gone), spots, centre }, now - scene.startedAt, where)
    const h = this.colony.groundAt(p.x, p.z) + p.h
    const pos = ball.holder.position
    // A player leaving re-draws the passes, which can move the ball's mark a long way in one
    // frame; it rolls over to the new mark rather than jumping there.
    const jump = Math.hypot(p.x - pos.x, p.z - pos.z)
    if (!ball.placed || jump < 0.6) pos.set(p.x, h, p.z)
    else pos.set(THREE.MathUtils.damp(pos.x, p.x, 10, dt), h, THREE.MathUtils.damp(pos.z, p.z, 10, dt))
    if (ball.placed) {
      // Rolled, not slid: it turns about the axis across its travel by distance over radius.
      const dx = pos.x - ball.last.x
      const dz = pos.z - ball.last.z
      const d = Math.hypot(dx, dz)
      if (d > 1e-4) {
        ball.axis.set(dz / d, 0, -dx / d)
        ball.q.setFromAxisAngle(ball.axis, d / BALL.R)
        ball.spinner.quaternion.premultiply(ball.q)
      }
    }
    ball.last.copy(pos)
    ball.placed = true
    ball.pop = Math.min(1, ball.pop + dt / BALL_POP_S)
    ball.holder.scale.setScalar(ball.pop)
  }

  // ── dev hook ────────────────────────────────────────────────────────────────────────

  /**
   * Start a scene now, to look at it: `force('heartbreak')`, `force('play', { variant: 'ball' })`,
   * `force('group', { size: 5 })`, or with `ids` to name the cast (for heartbreak the first is the
   * sad one). Takes idle bots not already in a scene, ignoring rest and the limits, and returns the
   * scene's id — or null when there is nobody to cast. From the console:
   * `botCrossing.colony.social.force('chat')`.
   */
  force(kind, { ids = null, size = FORCE_SIZE[kind], variant = null, now = Date.now() } = {}) {
    if (!SCENE_MS[kind] || !this.enabled) return null
    const busy = new Set(this.planner.active.flatMap((s) => s.cast.filter((id) => !s.gone.includes(id))))
    const free = this._bots().filter((b) => canSocialise(b) && !busy.has(b.id) && !this.standing.has(b.id))
    let members
    if (ids) {
      members = ids.map((id) => free.find((b) => b.id === id))
      if (members.some((b) => !b)) return null
    } else {
      members = null
      for (const anchor of free) {
        const others = free
          .filter((b) => b !== anchor && near(anchor, b))
          .sort((a, b) => Math.hypot(a.pos.x - anchor.pos.x, a.pos.z - anchor.pos.z) - Math.hypot(b.pos.x - anchor.pos.x, b.pos.z - anchor.pos.z))
        if (others.length + 1 >= size) {
          members = [anchor, ...others.slice(0, size - 1)]
          break
        }
      }
      if (!members) return null
    }
    let scene = makeScene(kind, members, now, this.planner.rand)
    for (let i = 0; variant && scene.variant !== variant && i < 50; i++) scene = makeScene(kind, members, now, this.planner.rand)
    this.planner.active.push(scene)
    return scene.id
  }

  /** What is on, for a look from the console. */
  scenes(now = Date.now()) {
    return this.planner.active.map((s) => ({
      id: s.id, kind: s.kind, variant: s.variant ?? null, cast: [...s.cast], gone: [...s.gone],
      t: now - s.startedAt, durationMs: s.durationMs,
    }))
  }

  dispose() {
    this._switchOff()
    this.emotes.dispose()
    this.colony.scene.remove(this.group)
  }
}
