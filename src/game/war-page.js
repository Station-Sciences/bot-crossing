/**
 * War mode, on the page side: who may be attacked, which friend is attacking us, and what a
 * finished battle does to the tally. The rules of the battle itself live in war.js; this is the
 * bookkeeping around it.
 *
 * Pure and browser-free so it runs under bare node, like neighbors.js.
 */
import { MARCH_MS, battleLive, canFight, phaseAt } from './war.js'
import { statusFor } from './status.js'

/** A friend's clock may run a little ahead of ours, but not a minute: past that it is not a battle we can show. */
export const FUTURE_SLACK_MS = 60000
export const SEEN_CAP = 50

export const otherSide = (side) => (side === 'attack' ? 'defend' : 'attack')

/** How many of a friend's threads (as hydrated for the colony) could fight right now. */
export function friendFighters(threads, now = Date.now()) {
  return (threads || []).filter((t) => canFight(statusFor(t, now))).length
}

/**
 * Why the Attack button on a friend's row is off, or '' when it is on. Checked in the order a
 * person would fix them, so the reason shown is the first thing to do about it.
 */
export function attackBlocker({ secure, enabled, sharing, result, name, homeFighters, friendFighters: theirs, busy, friendBusy }) {
  if (!secure) return 'War mode needs the page opened on localhost'
  if (!enabled) return 'Turn on war mode in Settings → Neighbors'
  if (!sharing) return `Turn on sharing so ${name} can see the battle`
  if (result?.status !== 'online') return `${name} is not here right now`
  if (result.snapshot?.warReady !== true) return `${name} has not turned on war mode`
  if (busy) return 'A battle is already on'
  // One battle per person: a friend who is attacking someone else would never notice ours, and
  // our screen would count a result theirs never saw.
  if (friendBusy) return `${name} is already in a battle`
  if (!(homeFighters > 0)) return 'None of your bots are free — busy bots never fight'
  if (!(theirs > 0)) return `None of ${name}'s bots are free`
  return ''
}

/**
 * Whether a friend's snapshot says they are in a battle: one they started, or — as a bare
 * `warBusy`, since the battle itself is in the attacker's snapshot — one they are defending.
 */
export function friendInBattle(snapshot, now = Date.now()) {
  return snapshot?.warBusy === true || battleLive(snapshot?.battle, now)
}

/**
 * The friend whose snapshot says they are attacking us, if any. `tagFor(battleId)` is our own tag
 * for that battle — salted per battle, so there is no single tag to look for — or nothing while it
 * is still being hashed. A battle we are already showing keeps its place over a newer one;
 * otherwise the one that started first wins. A battle claiming to start more than a minute from now
 * is a clock we cannot trust, and is ignored.
 */
export function incomingBattle(friends, tagFor, now = Date.now(), currentId = null) {
  if (typeof tagFor !== 'function') return null
  const aimedAtUs = (b) => {
    const tag = tagFor(b.id)
    return Boolean(tag) && b.target === tag
  }
  const hits = (friends || []).filter(
    (f) => f.battle && aimedAtUs(f.battle) && battleLive(f.battle, now) && f.battle.startedAt <= now + FUTURE_SLACK_MS
  )
  if (!hits.length) return null
  const kept = currentId && hits.find((f) => f.battle.id === currentId)
  const pick = kept || hits.reduce((a, b) => (b.battle.startedAt < a.battle.startedAt ? b : a))
  return { neighborId: pick.id, name: pick.name, battle: pick.battle }
}

/**
 * A finished battle, entered once. Returns the new `war` state and what to tell the person, or
 * null when this battle id was already counted (another tab, a reload, the same poll twice).
 */
export function recordResult(war, { battle, side, neighborId }, plan) {
  const seen = war?.seen || []
  if (!battle || seen.includes(battle.id)) return null
  const won = plan.winner === side
  const was = war?.tally?.[neighborId] || { won: 0, lost: 0 }
  const entry = { won: was.won + (won ? 1 : 0), lost: was.lost + (won ? 0 : 1) }
  return {
    war: {
      ...war,
      // Newest first: the server keeps the first fifty.
      seen: [battle.id, ...seen].slice(0, SEEN_CAP),
      tally: { ...(war?.tally || {}), [neighborId]: entry },
    },
    won,
    mine: plan.score[side],
    theirs: plan.score[otherSide(side)],
  }
}

/** `You beat Mark 7–4` or `Mark won 5–2` — the winner's score first. */
export function resultText(name, { won, mine, theirs }) {
  return won ? `You beat ${name} ${mine}–${theirs}` : `${name} won ${theirs}–${mine}`
}

/** `3–1`, won first, or '' before the first battle with this friend. */
export function formatRecord(entry) {
  if (!entry || (!entry.won && !entry.lost)) return ''
  return `${entry.won || 0}–${entry.lost || 0}`
}

/** `m:ss` */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * What the banner says about the battle's progress: a word while they march and when it is done,
 * the fight clock while it is on. Null once the battle is over and everyone is walking home.
 */
export function bannerPhase(plan, startedAt, now) {
  const { phase, t } = phaseAt(plan, startedAt, now)
  if (phase === 'over') return null
  if (phase === 'pending' || phase === 'march') return { phase, label: 'marching' }
  if (phase === 'fight') return { phase, label: clock(t - MARCH_MS) }
  return { phase, label: 'final' }
}
