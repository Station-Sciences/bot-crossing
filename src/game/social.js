// src/game/social.js
import { mulberry32 } from './war.js'

/**
 * Idle bots' social life, as plain rules: who gets together, when, for what, and what each of them
 * does moment by moment.
 *
 * A scene is a little play with a cast. The planner decides when one starts and when it is over;
 * the scene itself is a pure function of its own clock (`steps(t)`), so the director can ask "what
 * is everyone doing now?" every frame without the scene keeping any state — a frame dropped, a tab
 * left in the background, a bot that arrives late all come out right on the next ask.
 *
 * Everything that could be random is drawn from a seeded `rand`, and bots are always taken in id
 * order, so the same seed and the same colony give the same social life — which is what lets every
 * rule here be tested under node.
 *
 * Nothing here is written anywhere. Friends' bots join in on this screen only; theirs runs its own.
 *
 * What a step means to the bot layer, per cast member: `{ goal, face, action, emote, expression }`.
 *  - `goal` {x,z}: where to be. Away from it, the bot travels there — running if the action is `run`,
 *    walking otherwise. Null: stay put.
 *  - `face`: a point {x,z}, a cast member's id (look at that bot wherever it is now), or null (face
 *    the way it is going).
 *  - `action`: what to do on (or at) the goal, from ACTIONS. `walk` and `run` are just travelling;
 *    at the goal they settle into standing.
 *  - `emote`: a bubble from EMOTES beside the head, or null for none.
 *  - `expression`: a face from EXPRESSIONS, or null to leave the bot's own face alone.
 * None of these is a status look: no badge, no red eyes, no `error` face. Anger is `grumpy` and 💢.
 */

export const ACTIONS = Object.freeze(['walk', 'talk', 'wave', 'stomp', 'sit', 'stand', 'cheer', 'jump', 'run', 'kick'])
export const EMOTES = Object.freeze(['chat', 'angry', 'heartbreak', 'sad', 'love', 'ball', 'music'])
export const EXPRESSIONS = Object.freeze(['happy', 'wink', 'grumpy', 'sad', 'love', 'cheer'])

/** One scene per this many idle bots: a colony where everyone is always mid-chat reads as noise. */
export const BOTS_PER_SCENE = 6
export const MAX_SCENES = 8
/** How long each kind of scene runs, in ms. All within 6–15 s; heartbreak needs time for the walk over. */
export const SCENE_MS = Object.freeze({
  chat: [6000, 12000],
  group: [8000, 15000],
  argue: [6000, 10000],
  heartbreak: [10000, 15000],
  play: [8000, 15000],
})
/** A bot's rest after its part ends, so the same two do not chat on a loop. */
export const REST_MS = Object.freeze([30000, 60000])
/** Bots in different zones still count as neighbours this close (world units). */
export const NEAR = 15
/** How long a battle's result colours each side's mood. */
export const MOOD_MS = 60000
/** Ambient scene weights, in the order a draw walks them. */
export const AMBIENT = Object.freeze([['chat', 0.45], ['group', 0.2], ['play', 0.2], ['argue', 0.1], ['heartbreak', 0.05]])
/**
 * The pause after an ambient scene starts before the next may. Without it every free slot would
 * fill on the first frame after load, and the whole colony would strike up conversations at once.
 */
const AMBIENT_GAP_MS = [2000, 6000]
/** Cast sizes, and the fewest a scene can carry on with when someone is called away. */
const SIZE = { chat: [2, 2], group: [3, 5], argue: [2, 2], heartbreak: [2, 2], play: [2, 4] }

/** Beats within a scene. */
const GATHER_MS = 1500 // walking over before anything is said
const TURN_MS = 1800 // one speaker's turn
const STOMP_MS = 1200 // one side's turn at stomping
const FAREWELL_MS = 1200 // the wave, or the cheer, at the end
const PASS_MS = 1600 // between kicks
const KICK_MS = 500 // the kick itself
const SULK_MS = 1000 // still steaming as they walk off
/** Distances, in world units. */
const CHAT_GAP = 1.5
const ARGUE_GAP = 1.3
const WALK_OFF = 5
const COMFORT_GAP = 0.9
const BALL_RING = 2.4
const CHASE_RING = 2.6
const CHASE_SPIN = 1.1 // radians a second round the chase circle
const CHASE_LEAD = 0.5 // how far ahead round the circle a runner aims
const JUMP_EVERY_MS = 2400
const JUMP_MS = 450

/** Idle and not fighting. Sleeping is out: it means three days quiet, and waking it would misrepresent it. */
export const canSocialise = (bot) => !!bot && bot.status === 'idle' && !bot.atWar

/** Code-unit order, not locale, so every machine lines the same bots up the same way. */
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

/** Same settlement, and the same zone or close by: friends' bots stay in their own settlement. */
export const near = (a, b) =>
  a.owner === b.owner && ((a.zone != null && a.zone === b.zone) || dist(a.pos, b.pos) <= NEAR)

/** How many scenes this roster may have running at once. */
export function sceneLimit(bots) {
  const idle = bots.filter(canSocialise).length
  return Math.min(MAX_SCENES, Math.floor(idle / BOTS_PER_SCENE))
}

/**
 * The ambient scene kind for a draw `r` in [0, 1). Summed in whole percent: 0.45 + 0.2 + 0.2 in
 * floating point is a hair over 0.85, which would quietly hand argument's first draws to play.
 */
export function pickAmbient(r) {
  let percent = 0
  for (const [kind, w] of AMBIENT) {
    percent += Math.round(w * 100)
    if (r < percent / 100) return kind
  }
  return AMBIENT[AMBIENT.length - 1][0]
}

const between = ([lo, hi], rand) => Math.round(lo + rand() * (hi - lo))

/**
 * Whether a scene can go on with the cast it has left: everyone it cannot do without must still be
 * idle, out of war and on the roster. A bot that has already left (`gone`) does not come back.
 */
export function stillValid(scene, bots) {
  const roster = new Map(bots.map((b) => [b.id, b]))
  const staying = scene.cast.filter((id) => !scene.gone.includes(id) && canSocialise(roster.get(id)))
  return staying.length >= SIZE[scene.kind][0]
}

/** What each cast member still in the scene should be doing at wall-clock `now`. */
export function partsAt(scene, now) {
  const steps = scene.steps(now - scene.startedAt)
  const out = {}
  for (const id of scene.cast) if (!scene.gone.includes(id)) out[id] = steps[id]
  return out
}

// --- geometry ---

const centroid = (points) => ({
  x: points.reduce((s, p) => s + p.x, 0) / points.length,
  z: points.reduce((s, p) => s + p.z, 0) / points.length,
})

/** The unit vector from a to b; two bots on the same spot are given a direction rather than NaN. */
function unit(a, b) {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const d = Math.hypot(dx, dz)
  return d < 1e-6 ? { x: 1, z: 0 } : { x: dx / d, z: dz / d }
}

const offset = (p, dir, by) => ({ x: p.x + dir.x * by, z: p.z + dir.z * by })

/** Two spots `gap` apart on the line between two bots, so neither has to walk round the other. */
function pairSpots([a, b], centre, gap) {
  const d = unit(a.pos, b.pos)
  return { [a.id]: offset(centre, d, -gap / 2), [b.id]: offset(centre, d, gap / 2) }
}

/**
 * Evenly spaced spots round `centre`, handed out in the order the bots already stand round it, so
 * nobody crosses the ring to reach their place. Returns the spots and that ring order.
 */
function ringSpots(members, centre, radius) {
  const bearing = (b) => Math.atan2(b.pos.z - centre.z, b.pos.x - centre.x)
  const ring = [...members].sort((a, b) => bearing(a) - bearing(b) || byId(a, b))
  const start = bearing(ring[0])
  const spots = {}
  ring.forEach((b, i) => {
    const angle = start + (i / ring.length) * Math.PI * 2
    spots[b.id] = { x: centre.x + Math.cos(angle) * radius, z: centre.z + Math.sin(angle) * radius }
  })
  return { spots, ring: ring.map((b) => b.id), start }
}

const step = (goal, face, action, emote = null, expression = null) => ({ goal, face, action, emote, expression })
const clampT = (t, d) => Math.min(Math.max(t, 0), d)

// --- the scenes ---

/** Two bots meet, face each other and take turns gesturing, then wave goodbye. */
function chat(scene, members) {
  const [a, b] = scene.cast
  const other = (id) => (id === a ? b : a)
  const spots = pairSpots(members, scene.centre, CHAT_GAP)
  const D = scene.durationMs
  return {
    ...scene,
    spots,
    steps(t) {
      t = clampT(t, D)
      const out = {}
      for (const id of scene.cast) {
        if (t < GATHER_MS) out[id] = step(spots[id], other(id), 'walk', null, 'happy')
        else if (t >= D - FAREWELL_MS) out[id] = step(spots[id], other(id), 'wave', null, 'happy')
        else {
          const speaker = scene.cast[Math.floor((t - GATHER_MS) / TURN_MS) % 2]
          out[id] = id === speaker
            ? step(spots[id], other(id), 'talk', 'chat', 'happy')
            : step(spots[id], other(id), 'stand', null, 'wink')
        }
      }
      return out
    },
  }
}

/** Three to five gather in a ring facing its middle; the turn to speak hops round the ring. */
function group(scene, members) {
  const n = members.length
  const { spots, ring } = ringSpots(members, scene.centre, 0.9 + 0.2 * n)
  const D = scene.durationMs
  const centre = scene.centre
  return {
    ...scene,
    spots,
    steps(t) {
      t = clampT(t, D)
      const out = {}
      const speaker = ring[Math.floor((t - GATHER_MS) / TURN_MS) % n]
      for (const id of scene.cast) {
        if (t < GATHER_MS) out[id] = step(spots[id], centre, 'walk', null, 'happy')
        else if (t >= D - FAREWELL_MS) out[id] = step(spots[id], centre, 'wave', null, 'happy')
        else if (id === speaker) out[id] = step(spots[id], centre, 'talk', 'chat', 'happy')
        else out[id] = step(spots[id], centre, 'stand', null, 'happy')
      }
      return out
    },
  }
}

/** Two face off and stomp in turn, then turn their backs and walk off in opposite directions. */
function argue(scene, members) {
  const [a, b] = scene.cast
  const other = (id) => (id === a ? b : a)
  const spots = pairSpots(members, scene.centre, ARGUE_GAP)
  const D = scene.durationMs
  const split = Math.round(D * 0.6)
  const away = {}
  for (const id of scene.cast) away[id] = offset(spots[id], unit(scene.centre, spots[id]), WALK_OFF)
  return {
    ...scene,
    spots,
    steps(t) {
      t = clampT(t, D)
      const out = {}
      for (const id of scene.cast) {
        if (t < GATHER_MS) out[id] = step(spots[id], other(id), 'walk', null, 'grumpy')
        else if (t < split) {
          const stomper = scene.cast[Math.floor((t - GATHER_MS) / STOMP_MS) % 2]
          out[id] = step(spots[id], other(id), id === stomper ? 'stomp' : 'stand', 'angry', 'grumpy')
        } else out[id] = step(away[id], null, 'walk', t < split + SULK_MS ? 'angry' : null, 'grumpy')
      }
      return out
    },
  }
}

/**
 * The first of the cast sits down heartbroken where it is; the second walks over, stands beside it
 * and comforts it; it stands up, cheered. 💔 then 😢 from the sad one, ❤️ from the comforter.
 */
function heartbreak(scene, members) {
  const [sad, pal] = members
  const spots = {
    [sad.id]: { x: sad.pos.x, z: sad.pos.z },
    [pal.id]: offset(sad.pos, unit(sad.pos, pal.pos), COMFORT_GAP),
  }
  const D = scene.durationMs
  const comfort = Math.round(D * 0.4)
  const better = Math.round(D * 0.75)
  return {
    ...scene,
    spots,
    steps(t) {
      t = clampT(t, D)
      const s = spots[sad.id]
      const p = spots[pal.id]
      if (t < comfort) {
        return {
          [sad.id]: step(s, null, 'sit', t < comfort / 2 ? 'heartbreak' : 'sad', 'sad'),
          [pal.id]: step(p, sad.id, 'walk'),
        }
      }
      if (t < better) {
        return {
          [sad.id]: step(s, pal.id, 'sit', 'sad', 'sad'),
          [pal.id]: step(p, sad.id, 'talk', 'love', 'love'),
        }
      }
      const cheered = t >= D - FAREWELL_MS
      return {
        [sad.id]: step(s, pal.id, cheered ? 'cheer' : 'stand', null, cheered ? 'cheer' : 'love'),
        [pal.id]: step(p, sad.id, 'stand', 'love', 'happy'),
      }
    },
  }
}

/**
 * Two to four play: either a ball kicked round the ring (`passes` says who kicks to whom when, in
 * scene time, for the director's ball), or chase — running round a circle together, jumping now
 * and then.
 */
function play(scene, members, rand) {
  const variant = rand() < 0.6 ? 'ball' : 'chase'
  const D = scene.durationMs
  const n = members.length
  const centre = scene.centre
  if (variant === 'ball') {
    const { spots, ring } = ringSpots(members, centre, BALL_RING)
    const passes = []
    for (let at = GATHER_MS, k = 0; at < D - FAREWELL_MS; at += PASS_MS, k++) {
      passes.push({ at, from: ring[k % n], to: ring[(k + 1) % n] })
    }
    return {
      ...scene,
      variant,
      spots,
      passes,
      steps(t) {
        t = clampT(t, D)
        const out = {}
        const k = Math.min(passes.length - 1, Math.floor((t - GATHER_MS) / PASS_MS))
        const pass = passes[k]
        for (const id of scene.cast) {
          if (t < GATHER_MS) out[id] = step(spots[id], centre, 'walk', null, 'happy')
          else if (t >= D - FAREWELL_MS) out[id] = step(spots[id], centre, 'cheer', 'music', 'cheer')
          else if (id === pass.from && t - pass.at < KICK_MS) out[id] = step(spots[id], pass.to, 'kick', 'ball', 'cheer')
          // Everyone watches the ball in: the receiver looks at the kicker, the rest at the receiver.
          else out[id] = step(spots[id], id === pass.to ? pass.from : pass.to, 'stand', null, 'happy')
        }
        return out
      },
    }
  }
  const { spots, ring, start } = ringSpots(members, centre, CHASE_RING)
  const round = (i, t) => {
    const angle = start + (i / n) * Math.PI * 2 + (Math.max(0, t - GATHER_MS) / 1000) * CHASE_SPIN
    return { x: centre.x + Math.cos(angle) * CHASE_RING, z: centre.z + Math.sin(angle) * CHASE_RING }
  }
  const stop = D - FAREWELL_MS
  return {
    ...scene,
    variant,
    spots,
    steps(t) {
      t = clampT(t, D)
      const out = {}
      const singer = ring[Math.floor(t / 1500) % n]
      ring.forEach((id, i) => {
        if (t < GATHER_MS) out[id] = step(spots[id], null, 'walk', null, 'happy')
        else if (t >= stop) out[id] = step(round(i, stop), centre, 'cheer', 'music', 'cheer')
        else {
          // Aim a little ahead round the circle, so the goal is always in front and they keep running.
          const goal = round(i, t + (CHASE_LEAD / CHASE_SPIN) * 1000)
          const jumping = (t - GATHER_MS + i * 700) % JUMP_EVERY_MS < JUMP_MS
          out[id] = step(goal, null, jumping ? 'jump' : 'run', id === singer ? 'music' : null, 'cheer')
        }
      })
      return out
    },
  }
}

const SHAPES = { chat, group, argue, heartbreak, play }

/**
 * A scene of `kind` for these bots (cast in this order: for heartbreak the first is the sad one),
 * starting at `now`. Exported so the director's dev hook can force any scene to look at it.
 */
export function makeScene(kind, members, now, rand) {
  const cast = members.map((b) => b.id)
  const scene = {
    id: `${kind}:${cast.join('+')}:${now}`,
    kind,
    cast,
    owner: members[0].owner,
    startedAt: now,
    durationMs: between(SCENE_MS[kind], rand),
    centre: centroid(members.map((b) => b.pos)),
    gone: [],
  }
  return SHAPES[kind](scene, members, rand)
}

// --- casting ---

function shuffle(list, rand) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Nearest first; ties by id (the pool is already in id order and the sort is stable). */
const byDistanceFrom = (anchor) => (a, b) => dist(a.pos, anchor.pos) - dist(b.pos, anchor.pos)

/**
 * A cast for `kind` from `pool`: a random anchor and its nearest neighbours. Anchors are tried in
 * random order until one has enough company, so a lone bot in a corner does not block the rest.
 */
function castFor(kind, pool, rand) {
  const [lo, hi] = SIZE[kind]
  const want = lo + Math.floor(rand() * (hi - lo + 1))
  for (const anchor of shuffle(pool, rand)) {
    const others = pool.filter((b) => b !== anchor && near(anchor, b)).sort(byDistanceFrom(anchor))
    if (others.length + 1 >= lo) return [anchor, ...others.slice(0, want - 1)]
  }
  return null
}

/**
 * One planning step. Pure: it reads its inputs and returns what changed.
 *
 * In: `now` (ms); `bots` `[{ id, status, pos: {x,z}, zone, owner, atWar, restUntil }]`; `events`
 * since the last step (`archived {zone, owner}`, `finished {id}`, `warResult {owner, won}`);
 * `active` scenes from the last step; `moods` from the last step; `ambientAt`, the earliest the next
 * ambient scene may start; and the seeded `rand`.
 *
 * Out: `start` (new scenes), `end` (ids of scenes now over), `left` (`{scene, id}` for each bot whose
 * part ended this step in a scene that goes on), and the next state — `active`, `moods`,
 * `ambientAt` — plus `rest`, `{ id: restUntil }` for every bot whose part just ended.
 *
 * Order matters: scenes end first (freeing their cast to rest), then events — which jump the queue
 * but still obey the limits — then the moods battles leave behind, then at most one ambient scene.
 * An event that cannot be cast right now (no free bots, no slot) is let go: these are moments, not
 * a backlog, and a heartbreak played a minute late would be about nothing.
 */
export function planSocial({ now, bots, events = [], active = [], moods = [], ambientAt = 0, rand = Math.random }) {
  const roster = [...bots].sort(byId)
  const lookup = new Map(roster.map((b) => [b.id, b]))
  const rest = {}
  const rested = (id) => {
    rest[id] = now + between(REST_MS, rand)
  }

  const end = []
  const left = []
  const live = []
  for (const scene of active) {
    if (now >= scene.startedAt + scene.durationMs || !stillValid(scene, roster)) {
      end.push(scene.id)
      for (const id of scene.cast) if (!scene.gone.includes(id)) rested(id)
      continue
    }
    const dropped = scene.cast.filter((id) => !scene.gone.includes(id) && !canSocialise(lookup.get(id)))
    for (const id of dropped) {
      left.push({ scene: scene.id, id })
      rested(id)
    }
    live.push(dropped.length ? { ...scene, gone: [...scene.gone, ...dropped] } : scene)
  }

  const inScene = new Set(live.flatMap((s) => s.cast.filter((id) => !s.gone.includes(id))))
  const taken = new Set()
  const free = roster.filter(
    (b) => canSocialise(b) && !inScene.has(b.id) && !(b.id in rest) && !((b.restUntil ?? 0) > now)
  )
  const avail = () => free.filter((b) => !taken.has(b.id))
  let slots = sceneLimit(roster) - live.length
  const start = []
  const begin = (kind, members) => {
    const scene = makeScene(kind, members, now, rand)
    start.push(scene)
    live.push(scene)
    for (const b of members) taken.add(b.id)
    slots--
  }

  let nextMoods = moods.filter((m) => m.until > now)
  for (const e of events) {
    if (e?.kind === 'warResult') {
      nextMoods = [...nextMoods.filter((m) => m.owner !== e.owner), { owner: e.owner, won: !!e.won, until: now + MOOD_MS }]
      continue
    }
    if (slots <= 0) continue
    if (e?.kind === 'archived') {
      // Someone from the same repo takes it hard; whoever is nearest comes over.
      const repo = avail().filter((b) => b.owner === e.owner && b.zone === e.zone)
      if (!repo.length) continue
      const sad = repo[Math.floor(rand() * repo.length)]
      const pal = avail().filter((b) => b !== sad && near(sad, b)).sort(byDistanceFrom(sad))[0]
      if (pal) begin('heartbreak', [sad, pal])
    } else if (e?.kind === 'finished') {
      // Done with its run, it asks a repo-mate out to play.
      const host = avail().find((b) => b.id === e.id)
      if (!host || host.zone == null) continue
      const mate = avail()
        .filter((b) => b !== host && b.owner === host.owner && b.zone === host.zone)
        .sort(byDistanceFrom(host))[0]
      if (mate) begin('play', [host, mate])
    }
  }

  // After a battle the losers sulk and bicker and the winners play. Taken in turns, so one side
  // cannot use up every slot before the other gets any.
  nextMoods.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
  const moody = new Set(nextMoods.map((m) => m.owner))
  let waiting = [...nextMoods]
  while (slots > 0 && waiting.length) {
    waiting = waiting.filter((m) => {
      if (slots <= 0) return false
      const kind = m.won ? 'play' : 'argue'
      const members = castFor(kind, avail().filter((b) => b.owner === m.owner), rand)
      if (members) begin(kind, members)
      return !!members
    })
  }

  let nextAmbient = ambientAt
  if (slots > 0 && now >= ambientAt) {
    const kind = pickAmbient(rand())
    const members = castFor(kind, avail().filter((b) => !moody.has(b.owner)), rand)
    if (members) {
      begin(kind, members)
      nextAmbient = now + between(AMBIENT_GAP_MS, rand)
    }
  }

  return { start, end, left, active: live, moods: nextMoods, ambientAt: nextAmbient, rest }
}

/**
 * The planner with its memory: live scenes, who is resting until when, battle moods, and the
 * ambient clock. The director makes one and calls `tick` a few times a second; everything it
 * decides is in `planSocial`, this only carries the state from one step to the next.
 */
export class SocialPlanner {
  constructor({ seed = 0x50c1a1 } = {}) {
    this.rand = mulberry32(seed)
    this.active = []
    this.moods = []
    this.ambientAt = 0
    this.rest = new Map()
  }

  tick({ now, bots, events = [] }) {
    for (const [id, until] of this.rest) if (until <= now) this.rest.delete(id)
    const roster = bots.map((b) =>
      this.rest.has(b.id) ? { ...b, restUntil: Math.max(b.restUntil ?? 0, this.rest.get(b.id)) } : b
    )
    const out = planSocial({
      now, bots: roster, events, active: this.active, moods: this.moods, ambientAt: this.ambientAt, rand: this.rand,
    })
    this.active = out.active
    this.moods = out.moods
    this.ambientAt = out.ambientAt
    for (const [id, until] of Object.entries(out.rest)) this.rest.set(id, until)
    return out
  }

  /** Everything over at once — social life switched off. Returns the ids of the scenes it ended. */
  clear() {
    const ended = this.active.map((s) => s.id)
    this.active = []
    this.moods = []
    return ended
  }
}
