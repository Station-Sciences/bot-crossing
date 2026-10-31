import { ACTIONS, EMOTES, EXPRESSIONS } from '../game/social.js'

/**
 * Scene orders for a bot: the part of its social life that is a rule rather than a picture.
 *
 * The social director hands each bot in a scene its current step every frame — where to be,
 * who to look at, what to do there, which bubble and which face — and the astronauts carry it
 * out with the same walking and the same baked clips as everything else. This is the half of
 * that which needs no three.js: who may take a step at all, which of a bot's two kinds of
 * orders it obeys, what a messy step means, and which clip each action plays.
 *
 * Its own module so the rules run under node, as war-orders.js does; astronauts.js cannot.
 */

/**
 * Out in the colony and on its feet, as for war, but stricter about the thread: only `idle`.
 * A sleeper is three days quiet and stays sat down — waking it for a chat would say it had
 * stirred — and a thread with work to show never stops to socialise.
 */
const MINGLING = new Set(['at-site', 'walking'])

export const mayMingle = (agent) => Boolean(agent) && agent.status === 'idle' && MINGLING.has(agent.state)

/**
 * Which orders a bot is following, if any. War outranks a scene outright: a bot with battle
 * orders is a fighter, whatever part a scene had given it.
 */
export const orderLayer = (agent) => (agent?.war ? 'war' : agent?.scene ? 'scene' : null)

/**
 * Whether a bot may hold a scene step this frame: not at war, and still idle and on its feet.
 * Checked every frame, not only when the step is given — a thread can wake mid-chat.
 */
export const keepsScene = (agent) => mayMingle(agent) && !agent.war

const finite = (n) => typeof n === 'number' && Number.isFinite(n)
const point = (p) => (p && finite(p.x) && finite(p.z) ? { x: p.x, z: p.z } : null)

/**
 * A step as the bot will keep it, or null if it is not one. Copied rather than kept, so a
 * director that reuses one object for every bot cannot move them all by editing it.
 *
 * A goal that is given but broken is refused rather than read as "stay put": that would be a
 * bot quietly doing something it was not told. A broken face, emote or expression is just
 * dropped, the way a broken weapon is in a battle order — the bot still knows where to be.
 */
export function cleanStep(step) {
  if (!step || typeof step !== 'object' || !ACTIONS.includes(step.action)) return null
  const goal = step.goal == null ? null : point(step.goal)
  if (step.goal != null && !goal) return null
  const face = typeof step.face === 'string' && step.face ? step.face : point(step.face)
  return {
    goal,
    face,
    action: step.action,
    emote: EMOTES.includes(step.emote) ? step.emote : null,
    expression: EXPRESSIONS.includes(step.expression) ? step.expression : null,
  }
}

/** How far a goal has to move before an arrived bot counts as having somewhere new to be. */
const MOVED = 0.5

/**
 * Fold a fresh step into the one a bot already holds. Steps are re-issued every frame, so an
 * unchanged action keeps its clock, and a bot that has arrived stays arrived while its goal
 * stays put — a chat's turns change the action under a bot that is already standing there.
 */
export function nextStep(held, clean) {
  const same = held && held.action === clean.action
  const stay = held && (held.goal && clean.goal
    ? Math.hypot(held.goal.x - clean.goal.x, held.goal.z - clean.goal.z) < MOVED
    : !held.goal && !clean.goal)
  return { ...clean, t: same ? held.t : 0, arrived: stay ? held.arrived : false }
}

/** Close enough to a moving goal to stop chasing it. Small, and never sticky: see below. */
const CHASE_ARRIVE = 0.45
/**
 * Close enough to a scene spot to call it reached, and how far off it a bot has to be shoved
 * before it walks back. Much tighter than a battle's 0.7: two bots coming at a chat from
 * opposite sides each stopped 0.7 short and talked from nearly 3 apart (1.5 meant), which reads
 * as two strangers. Still clear of the crowd's spacing (1.15): a comforter whose spot is 0.9
 * beside its friend is held off at about 1.15, 0.25 from its spot, so it is never left shoving.
 */
const SPOT_ARRIVE = 0.3
const SPOT_REJOIN = 1.2

/**
 * Whether the bot should travel this frame, given how far its goal is. Walking to a spot is
 * sticky, the way a battle's is, so a pair shoved together by their own spacing do not shuffle
 * back and forth on it. A chase is not: its goal runs on ahead every frame, and a bot that
 * waited to be shoved well off it would stand still while the game went round without it.
 */
export function sceneArrival(step, dist) {
  // No goal is "where you are", which is somewhere already reached.
  if (dist === null) {
    step.arrived = true
    return false
  }
  if (step.action !== 'run') {
    step.arrived = step.arrived ? dist <= SPOT_REJOIN : dist <= SPOT_ARRIVE
    return !step.arrived
  }
  step.arrived = dist <= CHASE_ARRIVE
  return !step.arrived
}

/**
 * How much faster than its walk the bot goes. A run is a run — fast enough to be in the run
 * clip whatever the bot's own pace; everything else strolls over at its usual walk.
 */
export const scenePace = (step) => (step.action === 'run' ? 1.75 : 1)

/** Clips that are a single movement: once started they finish, whatever the next step says. */
const ONE_SHOTS = new Set(['jump', 'kick', 'kickBack'])
const SEATED = new Set(['sit', 'sitDown'])

/** The clip each action plays once the bot is standing where it should be. */
const ACTION_CLIP = {
  walk: 'idle',
  run: 'idle',
  stand: 'idle',
  talk: 'talk',
  wave: 'wave',
  stomp: 'stomp',
  cheer: 'cheer',
  jump: 'jump',
  kick: 'kick',
}

/**
 * The clip a bot in a scene plays. `stride` is the walk or run its feet need, or null when it
 * is standing; `prev` is the clip it is on, and `prevDone` whether that one-shot has finished.
 *
 * - A jump or a kick that has started is played out: a leap cut off at the crouch is a
 *   twitch. A jump also wins over a stride, which is what a leap in the middle of a chase is.
 * - A kick holds its leg up for as long as the step says kick, and then lets it down again
 *   rather than snapping it back.
 * - Sitting is the sleepers' sit-down, then the seated loop. Getting up from it is the
 *   stand-up, played through, before anything else — nobody pops upright off the floor.
 * - Otherwise the feet come first, as everywhere else, then the action.
 */
export function sceneClip(step, stride, prev, prevDone) {
  if (ONE_SHOTS.has(prev) && !prevDone) return prev
  if (prev === 'kick' && step.action !== 'kick') return 'kickBack'
  if (step.action === 'jump') return 'jump'
  if (stride) return stride
  if (step.action === 'sit') return SEATED.has(prev) ? prev : 'sitDown'
  if (SEATED.has(prev) || (prev === 'standUp' && !prevDone)) return 'standUp'
  return ACTION_CLIP[step.action] || 'idle'
}

/**
 * How fast a scene's clip plays, against its authored speed. A jump taken on the run is played
 * at double time: the clip's slow crouch and landing are a standing jump's, and at full length
 * a bot leaping in a chase spends half the game squatting while it slides along the ground.
 */
export const sceneRate = (key, stride) => (key === 'jump' && stride ? 2 : 1)

/** A stomp's rhythm: a sharp little hop off both feet, down hard, a beat, and again. */
export const STOMP_EVERY = 0.6
const STOMP_UP = 0.26
const STOMP_HEIGHT = 0.07

/**
 * How far off the ground the bot is lifted this frame, on top of whatever its clip does. Only
 * a stomp lifts: the indignant hop is the whole of it, since the clip under it just stands
 * stiffly with its arms rammed down. The others' clips carry their own motion.
 */
export function sceneHop(step) {
  if (step.action !== 'stomp' || !step.arrived) return 0
  const u = step.t % STOMP_EVERY
  return u < STOMP_UP ? STOMP_HEIGHT * Math.sin((Math.PI * u) / STOMP_UP) : 0
}

/**
 * The point a bot should be looking at, or null for "the way it is going". A face that is a
 * cast member's id follows that bot wherever it now is; one that names a bot no longer here,
 * or the bot itself, is no face at all. `where(id)` gives a bot's live position or null.
 */
export function faceTarget(face, self, where) {
  if (face == null) return null
  if (typeof face !== 'string') return face
  if (face === self) return null
  return where(face) || null
}
