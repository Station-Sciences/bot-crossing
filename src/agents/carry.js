/**
 * Picking a bot up and putting it down again.
 *
 * A carried bot belongs to no one but the pointer: it is a `held` state that the update
 * loop leaves alone. Letting go is the whole point of the gesture, so a release does not
 * pick a new place — it hands the bot back to the ordinary `walking` state, whose goal is
 * still the site it was given, and the router takes it home from wherever it landed.
 */

/** How high a carried bot dangles, in metres. Enough to read as "picked up". */
export const CARRY_LIFT = 0.9

/** Distance under which the way home is an ordinary walk. */
const HOME_STROLL = 5
/** Extra distance that adds one more multiple of walk speed. */
const HOME_RAMP = 17.5
/** The fastest a bot will bolt home, as a multiple of its own walk speed. */
const HOME_RUN_MAX = 3

const GRABBABLE = new Set(['at-site', 'walking'])

/** Anyone out in the colony. Not the ones still in the ship, on the ramp, or heading home for good. */
export function canGrab(agent) {
  return GRABBABLE.has(agent.state)
}

export function grab(agent) {
  if (!canGrab(agent)) return false
  agent.state = 'held'
  agent.stateAge = 0
  agent.vel.set(0, 0, 0)
  agent.groundSpeed = 0
  agent.homeRun = false
  agent.carryX = agent.pos.x
  agent.carryZ = agent.pos.z
  agent.glideVx = 0
  agent.glideVz = 0
  return true
}

/** How quickly a held bot catches up with the pointer. Higher is snappier, lower is floatier. */
const FOLLOW_RATE = 12

/**
 * Where the pointer is on the ground. The bot does not jump there: a pointer can cross the
 * screen in a frame, and a bot that teleports with it looks thrown about. `followCarry`
 * eases it across instead.
 */
export function carryTo(agent, x, z) {
  if (agent.state !== 'held') return
  agent.carryX = x
  agent.carryZ = z
}

/** One frame of the ease toward the carry target. Height is the update loop's. */
export function followCarry(agent, dt) {
  if (agent.state !== 'held' || agent.carryX === undefined) return
  const k = 1 - Math.exp(-FOLLOW_RATE * dt)
  const dx = (agent.carryX - agent.pos.x) * k
  const dz = (agent.carryZ - agent.pos.z) * k
  agent.pos.x += dx
  agent.pos.z += dz
  // How fast it was just dragged, which is what makes it swing.
  agent.glideVx = dx / dt
  agent.glideVz = dz / dt
}

export function release(agent) {
  if (agent.state !== 'held') return false
  agent.state = 'walking'
  agent.stateAge = 0
  agent.pathVersion = -1
  agent.stuckFor = 0
  agent.homeRun = true
  return true
}

/**
 * How much faster than its usual walk a dropped bot heads home, by how far it has to go:
 * nothing nearby, a jog in the middle, a flat-out run when it was put somewhere silly.
 */
export function homeRunFactor(distance) {
  return Math.min(HOME_RUN_MAX, Math.max(1, 1 + (distance - HOME_STROLL) / HOME_RAMP))
}

/** Below this the feet count as on the ground again. */
const LANDED = 0.12

/** Stride rate of the flail: fast enough that legs and arms read as kicking, not walking. */
export const FLAIL_RATE = 1.9

/**
 * Off the ground because of a carry: in hand, falling off the edge, or still dropping the
 * last of the way after being put down. A bot in this state kicks and flails like a child
 * being picked up, and does not start walking until its feet are on the ground.
 */
export function isAirborne(agent) {
  return agent.state === 'held' || agent.state === 'falling' || (agent.homeRun && agent.hop > LANDED)
}

/** Metres per second squared. A touch under real gravity: a tumble to watch, not a blink. */
const GRAVITY = 22
/** How far below the island a bot has to be before it counts as lost to the clouds. */
export const FALL_DEPTH = 70

/** Dropped over nothing: no way home from here, it goes over the edge. */
export function startFall(agent) {
  if (agent.state !== 'held') return false
  agent.state = 'falling'
  agent.stateAge = 0
  agent.fallV = 0
  agent.homeRun = false
  return true
}

/** One frame of the fall. True once it is far enough down to be gone. */
export function fallStep(agent, dt) {
  agent.fallV += GRAVITY * dt
  agent.hop -= agent.fallV * dt
  return agent.hop <= -FALL_DEPTH
}

// ── the cartoon on top ────────────────────────────────────────────────────────────────
//
// None of this is a clip. It is a spring or two on the whole body — tilt and stretch —
// that the renderer adds to the root transform. A held bot is pulled up taller as it
// leaves the ground, swings out behind the way you drag it like a puppet on a string,
// wriggles on its own in between, squashes flat when it lands, and tumbles if it is
// dropped over nothing.

/** Radians of lean per metre per second of drag. */
const SWING = 0.07
/** The furthest the body is allowed to lean from a drag, radians. */
const MAX_LEAN = 0.6
/** Spring stiffness and damping for the swing. Underdamped, so it overshoots and rocks. */
const TILT_K = 70
const TILT_C = 4.5
/** How hard it struggles in the hand, radians, and how fast. */
const WRIGGLE_Z = 0.2
const WRIGGLE_X = 0.12
/** Spring for stretch, kicked rather than set, so a pop overshoots and bounces. */
const STRETCH_K = 150
const STRETCH_C = 7
/** Velocity kicks: upward on pickup, downward on landing. */
const POP_KICK = 10
const SQUASH_KICK = -12
/** Head-over-heels rate while falling, radians per second. */
const TUMBLE = 7

/** One frame of body motion for the carry. Cheap and inert for any bot that is not being carried. */
export function stepCarryPose(agent, dt) {
  agent.tiltX ??= 0
  agent.tiltZ ??= 0
  agent.tiltVX ??= 0
  agent.tiltVZ ??= 0
  agent.stretch ??= 1
  agent.stretchV ??= 0
  const air = Boolean(isAirborne(agent))
  const wasAir = Boolean(agent.wasAirborne)
  agent.wasAirborne = air

  if (air && !wasAir) agent.stretchV += POP_KICK
  if (!air && wasAir) agent.stretchV += SQUASH_KICK

  if (!air && agent.tiltX === 0 && agent.tiltZ === 0 && agent.tiltVX === 0 && agent.tiltVZ === 0 &&
    agent.stretch === 1 && agent.stretchV === 0) return

  if (agent.state === 'falling') {
    agent.tiltX += TUMBLE * dt
    agent.tiltVX = 0
  } else {
    // Whole turns from a tumble are not unwound on the way down: land upright.
    if (Math.abs(agent.tiltX) > Math.PI) agent.tiltX -= Math.round(agent.tiltX / (2 * Math.PI)) * 2 * Math.PI
    let targetX = 0
    let targetZ = 0
    if (agent.state === 'held') {
      // Top of the body leans the way the hand is going; the feet trail.
      const lean = (v) => Math.max(-MAX_LEAN, Math.min(MAX_LEAN, v * SWING))
      targetX = lean(agent.glideVz || 0)
      targetZ = -lean(agent.glideVx || 0)
      targetZ += Math.sin(agent.stateAge * 11) * WRIGGLE_Z
      targetX += Math.sin(agent.stateAge * 8.3 + 1) * WRIGGLE_X
    }
    agent.tiltVX += (-TILT_K * (agent.tiltX - targetX) - TILT_C * agent.tiltVX) * dt
    agent.tiltVZ += (-TILT_K * (agent.tiltZ - targetZ) - TILT_C * agent.tiltVZ) * dt
    agent.tiltX += agent.tiltVX * dt
    agent.tiltZ += agent.tiltVZ * dt
  }

  agent.stretchV += (-STRETCH_K * (agent.stretch - 1) - STRETCH_C * agent.stretchV) * dt
  agent.stretch += agent.stretchV * dt

  // Put it down exactly flat once it has come to rest, so a resting bot costs nothing.
  const still =
    Math.abs(agent.tiltX) < 0.002 && Math.abs(agent.tiltZ) < 0.002 &&
    Math.abs(agent.tiltVX) < 0.01 && Math.abs(agent.tiltVZ) < 0.01 &&
    Math.abs(agent.stretch - 1) < 0.002 && Math.abs(agent.stretchV) < 0.01
  if (!air && still) {
    agent.tiltX = agent.tiltZ = agent.tiltVX = agent.tiltVZ = 0
    agent.stretch = 1
    agent.stretchV = 0
  }
}
