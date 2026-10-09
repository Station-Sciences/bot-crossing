// src/game/war.js
/**
 * War mode's rules, as a pure function of three numbers.
 *
 * Two machines show one battle without ever talking during it: the attacker announces a seed and
 * the two head counts in its share snapshot, and both screens run this same function on them.
 * Whatever comes out — who falls when, who wins, the score — is therefore identical on both, and
 * nothing has to be negotiated while the fight is on. Each screen only decides *which* of the bots
 * it can see plays each part.
 */

export const MARCH_MS = 8000
export const FIGHT_MS = 60000
export const CHEER_MS = 6000
/** How long a finished battle stays in the snapshot, so a defender polling late still sees how it ended. */
export const LINGER_MS = 30000
export const MAX_FIGHTERS = 30
const TICK_MS = 1000
const MAX_VEHICLES = 3

/** Only bots with nothing to tell you go to war; anything working, waiting or stuck keeps its job. */
export const canFight = (status) => status === 'idle' || status === 'sleeping'

/** A small seeded generator, the same on every JavaScript engine. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const vehiclesFor = (n) => ({
  tanks: Math.min(MAX_VEHICLES, Math.floor(n / 8)),
  helis: Math.min(MAX_VEHICLES, Math.floor(n / 12)),
})

const fighters = (n) => Math.max(0, Math.min(MAX_FIGHTERS, Math.floor(Number(n) || 0)))

export function planBattle({ seed, attackers, defenders }) {
  const rand = mulberry32(seed)
  const count = { attack: fighters(attackers), defend: fighters(defenders) }
  const vehicles = { attack: vehiclesFor(count.attack), defend: vehiclesFor(count.defend) }
  const standing = { ...count }
  const power = (side) => standing[side] + vehicles[side].tanks * 3 + vehicles[side].helis * 2
  const events = []
  let t = 0
  while (t < FIGHT_MS && standing.attack > 0 && standing.defend > 0) {
    t += TICK_MS
    // Rolled in a fixed order, so both screens draw the same numbers in the same sequence.
    for (const side of ['defend', 'attack']) {
      const other = side === 'attack' ? 'defend' : 'attack'
      if (standing[side] === 0 || standing[other] === 0) continue
      const p = (0.6 * power(other)) / (power(side) + power(other))
      if (rand() < p) {
        events.push({ t, side, index: count[side] - standing[side] })
        standing[side] -= 1
      }
    }
  }
  // A wiped-out side ends the fight a beat after the last fall rather than at the full minute.
  const over = standing.attack === 0 || standing.defend === 0
  const fightMs = over ? Math.min(FIGHT_MS, t + 2000) : FIGHT_MS
  return {
    count,
    vehicles,
    events,
    fightMs,
    durationMs: MARCH_MS + fightMs + CHEER_MS,
    winner: standing.attack > standing.defend ? 'attack' : 'defend',
    score: { attack: count.defend - standing.defend, defend: count.attack - standing.attack },
  }
}

export function phaseAt(plan, startedAt, now) {
  const t = now - startedAt
  if (t < 0) return { phase: 'pending', t }
  if (t < MARCH_MS) return { phase: 'march', t }
  if (t < MARCH_MS + plan.fightMs) return { phase: 'fight', t }
  if (t < plan.durationMs) return { phase: 'cheer', t }
  return { phase: 'over', t }
}

const fallenBy = (plan, startedAt, now) => {
  const clock = now - startedAt - MARCH_MS
  return plan.events.filter((e) => e.t <= clock)
}

/** Knockouts each side has inflicted so far. */
export function scoreAt(plan, startedAt, now) {
  const fallen = fallenBy(plan, startedAt, now)
  return {
    attack: fallen.filter((e) => e.side === 'defend').length,
    defend: fallen.filter((e) => e.side === 'attack').length,
  }
}

/** Which of a side's fighters (by knockout order) are down by now. */
export function downAt(plan, side, startedAt, now) {
  return new Set(fallenBy(plan, startedAt, now).filter((e) => e.side === side).map((e) => e.index))
}

/**
 * Who is being attacked, in a form only they can read: their own share key, hashed. Other friends
 * reading the attacker's snapshot see a tag, not a name.
 */
export async function warTag(key) {
  const bytes = new TextEncoder().encode(`war:${key}`)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function newBattle({ targetNeighborId, targetKey, attackers, defenders, now = Date.now(), seed }) {
  const s = seed ?? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
  return {
    id: `war_${now.toString(36)}_${s.toString(36)}`,
    target: await warTag(targetKey),
    seed: s,
    startedAt: now,
    attackers: fighters(attackers),
    defenders: fighters(defenders),
    targetNeighborId,
  }
}

/** On screen, and in the snapshot, until it has been over for a little while. */
export function battleLive(battle, now = Date.now()) {
  if (!battle) return false
  return now < battle.startedAt + planBattle(battle).durationMs + LINGER_MS
}
